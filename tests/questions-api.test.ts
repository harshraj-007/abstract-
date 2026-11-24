import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/snapshots/[id]/questions/route";
import { SnapshotStore } from "@/lib/storage/snapshots";
import { analysisFixture, LEARNING_REPO } from "./helpers/analysis-fixtures";

const storage = vi.hoisted(() => ({ store: null as SnapshotStore | null }));
vi.mock("@/lib/storage/snapshots", async (original) => ({
  ...(await original<typeof import("@/lib/storage/snapshots")>()),
  getStore: () => storage.store!,
}));
afterEach(() => {
  storage.store?.close();
  storage.store = null;
  vi.unstubAllEnvs();
});
const fixture = analysisFixture(LEARNING_REPO);
const params = { params: Promise.resolve({ id: fixture.snapshot.id }) };
const url = `http://127.0.0.1:3001/api/snapshots/${fixture.snapshot.id}/questions`;
const draft = {
  question: "Explain this file",
  fileId: fixture.snapshot.files.find((file) => file.path === "src/app/page.tsx")!.id,
  line: 2,
  depth: "learn",
};
function request(body: unknown, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function setup() {
  storage.store = new SnapshotStore(":memory:");
  storage.store.saveSnapshot(fixture.snapshot);
  fixture.sources.forEach((source) => storage.store!.saveSource(source));
}
describe("question API boundaries", () => {
  it("previews local source without leaking the server key or calling the provider", async () => {
    setup();
    vi.stubEnv("GEMINI_API_KEY", "server-only-fixture");
    vi.stubEnv("GEMINI_MODEL", "gemini-fixture");
    const response = await POST(request({ action: "preview", draft }), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.report).toBeNull();
    expect(result.evidence[0].path).toBe("src/app/page.tsx");
    expect(result.draft.line).toBe(2);
    expect(JSON.stringify(result)).not.toContain("server-only-fixture");
    expect((await (await GET(new Request(url), params)).json()).answers).toEqual([]);
  });
  it.each([
    { action: "answer", draft },
    { action: "answer", draft, allowSourceSharing: false, evidenceFingerprint: "a".repeat(64) },
    {
      action: "answer",
      draft,
      allowSourceSharing: true,
      evidenceFingerprint: "a".repeat(64),
      apiKey: "browser-key",
    },
    { action: "preview", draft: { ...draft, fileId: "../../private" } },
    { action: "preview", draft: { ...draft, depth: "unbounded" } },
    { action: "read", draft: { ...draft, question: "" } },
  ])("rejects unsupported requests before accessing source", async (body) => {
    expect((await POST(request(body), params)).status).toBe(400);
  });
  it("rejects a foreign origin and oversized body", async () => {
    expect(
      (
        await POST(
          request({ action: "preview", draft }, { origin: "https://elsewhere.test" }),
          params,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request({ action: "preview", draft: { ...draft, question: "x".repeat(8200) } }),
          params,
        )
      ).status,
    ).toBe(413);
  });
  it("accepts a valid 1000-character Unicode question under the byte cap", async () => {
    setup();
    const response = await POST(
      request({ action: "preview", draft: { ...draft, question: "漢".repeat(1000) } }),
      params,
    );
    expect(response.status).toBe(200);
  });
  it("rejects unlisted scope, invalid IDs and missing answers", async () => {
    setup();
    expect(
      (
        await POST(
          request({ action: "preview", draft: { ...draft, fileId: "f".repeat(24) } }),
          params,
        )
      ).status,
    ).toBe(400);
    expect(
      (await GET(new Request(url), { params: Promise.resolve({ id: "../../private" }) })).status,
    ).toBe(404);
    expect((await GET(new Request(`${url}?answer=bad`), params)).status).toBe(404);
    expect(
      (await GET(new Request(`${url}?answer=5d07fa50-7a24-4fd9-838a-bc06b9b17c76`), params)).status,
    ).toBe(404);
  });
  it("rejects generation when question context changed after preview", async () => {
    setup();
    const preview = await (await POST(request({ action: "preview", draft }), params)).json();
    const response = await POST(
      request({
        action: "answer",
        draft: { ...draft, question: "Changed" },
        allowSourceSharing: true,
        evidenceFingerprint: preview.evidenceFingerprint,
      }),
      params,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("AI_EVIDENCE_CHANGED");
  });
});
