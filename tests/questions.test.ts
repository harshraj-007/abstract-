import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSnapshot } from "@/lib/analysis/analyze";
import { GenerationGate } from "@/lib/ai/gate";
import { QuestionService } from "@/lib/ai/questions";
import type { OverviewProvider } from "@/lib/ai/provider";
import type { QuestionContent, QuestionDraft } from "@/lib/contracts/questions";
import { GitHubClient } from "@/lib/github/client";
import { ExplorerError } from "@/lib/github/errors";
import { packQuestionEvidence, QUESTION_EVIDENCE_LIMITS } from "@/lib/retrieval/questions";
import { SnapshotStore } from "@/lib/storage/snapshots";
import { analysisFixture, LEARNING_REPO } from "./helpers/analysis-fixtures";
import { blobFor } from "./helpers/fixtures";

const stores: SnapshotStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
function setup(contents = LEARNING_REPO, cached = Object.keys(contents)) {
  const fixture = analysisFixture(contents, cached);
  const store = new SnapshotStore(":memory:");
  stores.push(store);
  store.saveSnapshot(fixture.snapshot);
  fixture.sources.forEach((source) => store.saveSource(source));
  const draft: QuestionDraft = {
    question: "How does Home use Widget?",
    fileId: fixture.snapshot.files.find((file) => file.path === "src/app/page.tsx")!.id,
    depth: "learn",
  };
  return { ...fixture, store, draft };
}
function response(evidence: string): QuestionContent {
  const parsed = JSON.parse(evidence);
  const claim = {
    text: "Fixture interpretation only.",
    status: "observed" as const,
    evidenceIds: [parsed.evidence[0].id],
    limitation: "",
  };
  return {
    answer: claim,
    steps: [{ title: "Read the declaration", explanation: claim }],
    takeaway: claim,
    concepts: [],
    limitations: ["Explicit fixture, not a live model response."],
  };
}
function service(generate?: OverviewProvider["generate"], gate?: GenerationGate) {
  const call = vi.fn(
    generate ??
      (async (input) => ({
        output: response(input.evidence),
        usage: { inputTokens: 100, outputTokens: 50 },
      })),
  );
  return {
    service: new QuestionService({
      env: () => ({ GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-fixture" }),
      provider: () => ({ generate: call }),
      gate,
    }),
    call,
  };
}
async function answer(
  fixture: ReturnType<typeof setup>,
  tutor: QuestionService,
  draft = fixture.draft,
) {
  const preview = await tutor.preview(fixture.snapshot.id, fixture.store, draft);
  return tutor.answer(fixture.snapshot.id, fixture.store, draft, {
    evidenceFingerprint: preview.evidenceFingerprint!,
  });
}

describe("question evidence", () => {
  it("centers on a selected line or named declaration and retains exact source ranges", () => {
    const contents = {
      ...LEARNING_REPO,
      "src/app/page.tsx": [
        ...Array.from({ length: 140 }, (_, i) => `// context ${i}`),
        "export function lateHandler() { return 1; }",
      ].join("\n"),
    };
    const f = setup(contents);
    const analysis = analyzeSnapshot(f.snapshot, f.sources);
    for (const draft of [
      { ...f.draft, line: 141 },
      { ...f.draft, question: "Explain lateHandler" },
    ]) {
      const bundle = packQuestionEvidence(f.snapshot, analysis, f.sources, draft);
      expect(bundle.excerpts[0].startLine).toBe(131);
      expect(bundle.excerpts[0].text).toContain("lateHandler");
      expect(bundle.excerpts[0].wholeFile).toBe(false);
      expect(bundle.excerpts[1].startLine).toBe(1);
    }
  });
  it("bounds serialized UTF-8 bytes and changes fingerprints with question, scope and depth", () => {
    const contents = { ...LEARNING_REPO };
    for (let i = 0; i < 18; i++)
      contents[`src/lib/widget${i}.ts`] = Array.from(
        { length: 90 },
        (_, j) => `export const widget${j} = "${"漢".repeat(30)}";`,
      ).join("\n");
    const f = setup(contents);
    const analysis = analyzeSnapshot(f.snapshot, f.sources);
    const bundle = packQuestionEvidence(f.snapshot, analysis, f.sources, f.draft);
    expect(bundle.excerpts.length).toBeLessThanOrEqual(QUESTION_EVIDENCE_LIMITS.excerpts);
    expect(bundle.payloadBytes).toBe(Buffer.byteLength(bundle.userText));
    expect(bundle.payloadBytes).toBeLessThanOrEqual(32000);
    for (const item of bundle.excerpts)
      expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(6000);
    for (const next of [
      { ...f.draft, question: "Another question" },
      { ...f.draft, depth: "quick" as const },
      { ...f.draft, line: 2 },
    ])
      expect(packQuestionEvidence(f.snapshot, analysis, f.sources, next).fingerprint).not.toBe(
        bundle.fingerprint,
      );
    expect(
      packQuestionEvidence(f.snapshot, analysis, [...f.sources].reverse(), f.draft).fingerprint,
    ).toBe(bundle.fingerprint);
  });
  it("rejects out-of-range lines and excludes tampered source, credentials and imported policy files", () => {
    const f = setup({
      ...LEARNING_REPO,
      "GEMINI.md": "widget policy",
      "src/lib/key.ts": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    f.sources.find((source) => source.path === "src/components/widget.tsx")!.content += "tampered";
    const analysis = analyzeSnapshot(f.snapshot, f.sources);
    const bundle = packQuestionEvidence(f.snapshot, analysis, f.sources, f.draft);
    expect(bundle.excerpts.some((item) => /GEMINI|key|components\/widget/.test(item.path))).toBe(
      false,
    );
    expect(() =>
      packQuestionEvidence(f.snapshot, analysis, f.sources, { ...f.draft, line: 999 }),
    ).toThrow("outside");
  });
  it("lists unread direct targets without fabricating source", () => {
    const f = setup(LEARNING_REPO, ["src/app/page.tsx", "package.json", "tsconfig.json"]);
    const bundle = packQuestionEvidence(
      f.snapshot,
      analyzeSnapshot(f.snapshot, f.sources),
      f.sources,
      f.draft,
    );
    expect(JSON.parse(bundle.userText).unreadDirectTargets).toContain("src/components/widget.tsx");
    expect(
      bundle.excerpts.find((item) => item.path === "src/components/widget.tsx"),
    ).toBeUndefined();
  });
});

describe("question generation and persistence", () => {
  it("previews locally, validates and saves an answer, then reuses it without another model request", async () => {
    const f = setup();
    const tutor = service();
    const preview = await tutor.service.preview(f.snapshot.id, f.store, f.draft);
    expect(tutor.call).not.toHaveBeenCalled();
    expect(preview.report).toBeNull();
    const first = await answer(f, tutor.service);
    const second = await answer(f, tutor.service);
    expect(first.report?.evidence.length).toBeGreaterThan(0);
    expect(second.cacheHit).toBe(true);
    expect(second.report?.id).toBe(first.report?.id);
    expect(tutor.call).toHaveBeenCalledOnce();
    expect(tutor.call.mock.calls[0][0].maxOutputTokens).toBe(4000);
    expect(f.store.recentQuestions(f.snapshot.id)).toHaveLength(1);
    const offline = new QuestionService({ env: () => ({}) });
    expect((await offline.saved(f.snapshot.id, f.store, first.report!.id)).stale).toBe(false);
  });
  it("requires a fresh preview after editing question, depth or focus", async () => {
    const f = setup();
    const tutor = service();
    const preview = await tutor.service.preview(f.snapshot.id, f.store, f.draft);
    for (const draft of [
      { ...f.draft, question: "Different" },
      { ...f.draft, depth: "deep" as const },
      { ...f.draft, line: 2 },
    ])
      await expect(
        tutor.service.answer(f.snapshot.id, f.store, draft, {
          evidenceFingerprint: preview.evidenceFingerprint!,
        }),
      ).rejects.toMatchObject({ code: "AI_EVIDENCE_CHANGED" });
    expect(tutor.call).not.toHaveBeenCalled();
  });
  it.each(["invented", "inference", "unknown", "extra-field"])(
    "rejects invalid %s output without saving it",
    async (kind) => {
      const f = setup();
      const tutor = service(async (input) => {
        const content = response(input.evidence);
        if (kind === "invented") content.answer.evidenceIds = ["ev_fabricated"];
        if (kind === "inference") content.answer.status = "inferred";
        if (kind === "unknown") {
          content.answer.status = "unknown";
          content.answer.evidenceIds = [];
        }
        return {
          output: kind === "extra-field" ? { ...content, unexpected: true } : content,
          usage: {},
        };
      });
      await expect(answer(f, tutor.service)).rejects.toMatchObject({
        code: "AI_INVALID_REFERENCES",
      });
      expect(f.store.recentQuestions(f.snapshot.id)).toHaveLength(0);
    },
  );
  it("does not persist an answer after source changes, snapshot deletion or cancellation", async () => {
    for (const action of ["source", "delete", "cancel"]) {
      const f = setup();
      const controller = new AbortController();
      const tutor = service(async (input) => {
        if (action === "delete") f.store.deleteSnapshot(f.snapshot.id);
        if (action === "source") {
          const source = f.sources[0];
          f.store.saveSource({ ...source, content: source.content + "changed" });
        }
        if (action === "cancel") controller.abort();
        return { output: response(input.evidence), usage: {} };
      });
      const preview = await tutor.service.preview(f.snapshot.id, f.store, f.draft);
      await expect(
        tutor.service.answer(f.snapshot.id, f.store, f.draft, {
          evidenceFingerprint: preview.evidenceFingerprint!,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: action === "cancel" ? "CANCELLED" : "AI_EVIDENCE_CHANGED" });
      expect(f.store.recentQuestions(f.snapshot.id)).toHaveLength(0);
    }
  });
  it("preserves prior answers through provider failure and exposes a shared cooldown", async () => {
    const f = setup();
    const first = await answer(f, service().service);
    const gate = new GenerationGate();
    const retryAt = new Date(Date.now() + 90000).toISOString();
    const failed = service(async () => {
      throw new ExplorerError("AI_RATE_LIMITED", "Fixture limit", 429, retryAt);
    }, gate);
    await expect(
      answer(f, failed.service, { ...f.draft, question: "New question" }),
    ).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    const next = service(undefined, gate);
    expect((await next.service.preview(f.snapshot.id, f.store, f.draft)).retryAt).toBe(retryAt);
    await expect(
      answer(f, next.service, { ...f.draft, question: "Third question" }),
    ).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });
    expect(next.call).not.toHaveBeenCalled();
    expect(f.store.getQuestion(f.snapshot.id, { id: first.report!.id })).not.toBeNull();
  });
  it("marks a report stale after model settings change and isolates answers by snapshot", async () => {
    const f = setup();
    const result = await answer(f, service().service);
    const changed = new QuestionService({ env: () => ({ GEMINI_MODEL: "gemini-other" }) });
    expect((await changed.saved(f.snapshot.id, f.store, result.report!.id)).stale).toBe(true);
    const otherId = randomUUID();
    f.store.saveSnapshot({ ...f.snapshot, id: otherId });
    await expect(changed.saved(otherId, f.store, result.report!.id)).rejects.toMatchObject({
      code: "ANSWER_NOT_FOUND",
    });
  });
  it("retains at most 20 answers and removes them with their snapshot", async () => {
    const f = setup();
    const result = await answer(f, service().service);
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const id = randomUUID();
      ids.push(id);
      f.store.saveQuestion({
        ...result.report!,
        id,
        cacheKey: `fixture-${i}`,
        createdAt: new Date(1800000000000 + i).toISOString(),
      });
    }
    expect(f.store.recentQuestions(f.snapshot.id)).toHaveLength(20);
    expect(f.store.getQuestion(f.snapshot.id, { id: ids[0] })).toBeNull();
    f.store.deleteSnapshot(f.snapshot.id);
    expect(f.store.getQuestion(f.snapshot.id, { id: ids.at(-1)! })).toBeNull();
  });
  it("rejects a question containing credential patterns before any provider call", async () => {
    const f = setup();
    const tutor = service();
    await expect(
      tutor.service.preview(f.snapshot.id, f.store, {
        ...f.draft,
        question: "Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUESTION" });
    expect(tutor.call).not.toHaveBeenCalled();
  });
});

describe("bounded additional question context", () => {
  it("reads focus first, configs, then direct imports, caps new requests at four and reuses downloads", async () => {
    const f = setup(LEARNING_REPO, []);
    const tutor = service();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const sha = String(input).split("/").at(-1);
      const content = Object.values(LEARNING_REPO).find((text) => blobFor(text).sha === sha);
      if (content === undefined) throw new Error("Unknown fixture");
      return Response.json(blobFor(content));
    });
    const client = new GitHubClient({ fetch: fetcher });
    const before = await tutor.service.preview(f.snapshot.id, f.store, f.draft);
    expect(before.canGenerate).toBe(false);
    expect(before.evidence).toHaveLength(0);
    const read = await tutor.service.readContext(f.snapshot.id, f.store, f.draft, client);
    expect(read.attempted).toBe(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      blobFor(LEARNING_REPO["src/app/page.tsx"]).sha,
    );
    expect(read.failures).toHaveLength(0);
    const after = await tutor.service.preview(f.snapshot.id, f.store, f.draft);
    expect(after.evidence[0].path).toBe("src/app/page.tsx");
    expect(f.store.getAnalysis(f.snapshot.id)).not.toBeNull();
    const more = await tutor.service.readContext(f.snapshot.id, f.store, f.draft, client);
    expect(more.attempted).toBe(1);
    expect(
      (await tutor.service.readContext(f.snapshot.id, f.store, f.draft, client)).attempted,
    ).toBe(0);
    expect(tutor.call).not.toHaveBeenCalled();
  });
  it("stops on quota and preserves files downloaded before cancellation", async () => {
    const f = setup(LEARNING_REPO, []);
    const tutor = service();
    const quotaFetch = vi.fn(async () =>
      Response.json({ message: "Fixture quota" }, { status: 429 }),
    );
    const quota = await tutor.service.readContext(
      f.snapshot.id,
      f.store,
      f.draft,
      new GitHubClient({ fetch: quotaFetch }),
    );
    expect(quota.attempted).toBe(1);
    expect(quota.failures[0].code).toBe("RATE_LIMITED");
    const second = setup(LEARNING_REPO, []);
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return Response.json(blobFor(LEARNING_REPO["src/app/page.tsx"]));
    });
    await expect(
      tutor.service.readContext(
        second.snapshot.id,
        second.store,
        second.draft,
        new GitHubClient({ fetch: fetcher }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(second.store.getSource(second.snapshot.id, second.draft.fileId)).not.toBeNull();
    expect(second.store.getAnalysis(second.snapshot.id)).toBeNull();
  });
});
