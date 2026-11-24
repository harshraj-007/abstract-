import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "@/lib/storage/snapshots";
import { analyzeSnapshot } from "@/lib/analysis/analyze";
import { analysisFixture, LEARNING_REPO } from "./helpers/analysis-fixtures";
import { GET, POST } from "@/app/api/snapshots/[id]/overview/route";

const storage = vi.hoisted(() => ({ store: null as SnapshotStore | null }));
vi.mock("@/lib/storage/snapshots", async (original) => {
  const storageModule = await original<typeof import("@/lib/storage/snapshots")>();
  return { ...storageModule, getStore: () => storage.store! };
});
afterEach(() => {
  storage.store?.close();
  storage.store = null;
  vi.unstubAllEnvs();
});

describe("overview API access and sharing boundaries", () => {
  const fixture = analysisFixture(LEARNING_REPO);
  const params = { params: Promise.resolve({ id: fixture.snapshot.id }) };
  function request(body: unknown, headers: Record<string, string> = {}) {
    return new Request(`http://127.0.0.1:3000/api/snapshots/${fixture.snapshot.id}/overview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  it("previews cached source without exposing keys or generating a report", async () => {
    storage.store = new SnapshotStore(":memory:");
    storage.store.saveSnapshot(fixture.snapshot);
    for (const source of fixture.sources) storage.store.saveSource(source);
    storage.store.saveAnalysis(analyzeSnapshot(fixture.snapshot, fixture.sources));
    vi.stubEnv("GEMINI_API_KEY", "server-only-test-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-fixture");
    const response = await GET(new Request("http://127.0.0.1:3000"), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const state = await response.json();
    expect(state.report).toBeNull();
    expect(state.evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).not.toContain("server-only-test-key");
  });
  it.each([
    {},
    { allowSourceSharing: false, evidenceFingerprint: "a".repeat(64) },
    { allowSourceSharing: true, evidenceFingerprint: "a".repeat(64), apiKey: "browser-key" },
  ])("rejects absent consent and unsupported fields before service access", async (body) => {
    const response = await POST(request(body), params);
    expect(response.status).toBe(400);
  });
  it("rejects another origin before any source or provider access", async () => {
    const response = await POST(
      request(
        { allowSourceSharing: true, evidenceFingerprint: "a".repeat(64) },
        { origin: "https://unrelated.test" },
      ),
      params,
    );
    expect(response.status).toBe(403);
  });
  it("rejects invalid snapshot identities", async () => {
    const response = await GET(new Request("http://127.0.0.1:3000"), {
      params: Promise.resolve({ id: "../../private" }),
    });
    expect(response.status).toBe(404);
  });
  it("bounds overview request bodies", async () => {
    const response = await POST(
      request({ allowSourceSharing: true, evidenceFingerprint: "a".repeat(3000) }),
      params,
    );
    expect(response.status).toBe(413);
  });
});
