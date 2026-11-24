import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "@/lib/storage/snapshots";
import { GitHubClient } from "@/lib/github/client";
import { buildStructuralAnalysis, getAnalysisResult } from "@/lib/analysis/service";
import { analyzeSnapshot } from "@/lib/analysis/analyze";
import { analysisFixture, LEARNING_REPO } from "./helpers/analysis-fixtures";
import { blobFor } from "./helpers/fixtures";

let store: SnapshotStore;
beforeEach(() => {
  store = new SnapshotStore(":memory:");
});
afterEach(() => {
  store.close();
});

function clientFor(contents: Record<string, string>) {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const sha = url.split("/").at(-1);
    const content = Object.values(contents).find((content) => blobFor(content).sha === sha);
    if (content === undefined) return new Response("", { status: 404 });
    return Response.json(blobFor(content));
  });
  return { client: new GitHubClient({ fetch: fetcher as typeof fetch }), fetcher };
}

describe("bounded structural-map workflow", () => {
  it("builds from cached source with no GitHub requests and reuses the saved report", async () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO);
    store.saveSnapshot(snapshot);
    for (const source of sources) store.saveSource(source);
    const { client, fetcher } = clientFor(LEARNING_REPO);
    const result = await buildStructuralAnalysis(snapshot.id, store, client, {
      fetchMissing: false,
    });
    expect(result.analysis.coverage.parsedFiles).toBe(8);
    expect(fetcher).not.toHaveBeenCalled();
    const repeated = await buildStructuralAnalysis(snapshot.id, store, client, {
      fetchMissing: false,
    });
    expect(repeated.analysis.createdAt).toBe(result.analysis.createdAt);
    expect(store.getAnalysis(snapshot.id)?.id).toBe(result.analysis.id);
  });

  it("limits new downloads, persists them and expands incrementally", async () => {
    const { snapshot } = analysisFixture(LEARNING_REPO, []);
    store.saveSnapshot(snapshot);
    const { client, fetcher } = clientFor(LEARNING_REPO);
    const first = await buildStructuralAnalysis(snapshot.id, store, client, {
      fetchMissing: true,
      batchSize: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store.allSources(snapshot.id)).toHaveLength(3);
    expect(first.analysis.status).toBe("partial");
    const second = await buildStructuralAnalysis(snapshot.id, store, client, {
      fetchMissing: true,
      batchSize: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(second.analysis.coverage.parsedFiles).toBeGreaterThan(
      first.analysis.coverage.parsedFiles,
    );
  });

  it("reports stale evidence after another source file is opened", async () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO);
    store.saveSnapshot(snapshot);
    for (const source of sources.slice(0, 3)) store.saveSource(source);
    const { client } = clientFor(LEARNING_REPO);
    await buildStructuralAnalysis(snapshot.id, store, client, { fetchMissing: false });
    expect(getAnalysisResult(snapshot.id, store).stale).toBe(false);
    store.saveSource(sources[3]);
    expect(getAnalysisResult(snapshot.id, store).stale).toBe(true);
  });

  it("stops on GitHub rate limits and retains a useful partial report", async () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO, ["src/app/page.tsx"]);
    store.saveSnapshot(snapshot);
    for (const source of sources) store.saveSource(source);
    const fetcher = vi.fn(
      async () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    const result = await buildStructuralAnalysis(
      snapshot.id,
      store,
      new GitHubClient({ fetch: fetcher as typeof fetch }),
      { fetchMissing: true },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.analysis.coverage.parsedFiles).toBe(1);
    expect(result.analysis.downloadFailures[0].code).toBe("RATE_LIMITED");
    expect(store.getAnalysis(snapshot.id)).not.toBeNull();
  });

  it("honors cancellation without replacing a saved report", async () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO);
    store.saveSnapshot(snapshot);
    const original = analyzeSnapshot(snapshot, sources);
    store.saveAnalysis(original);
    const abort = new AbortController();
    abort.abort();
    const { client, fetcher } = clientFor(LEARNING_REPO);
    await expect(
      buildStructuralAnalysis(snapshot.id, store, client, {
        fetchMissing: true,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(store.getAnalysis(snapshot.id)?.id).toBe(original.id);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes the map when its parent snapshot is removed", () => {
    const { snapshot, sources } = analysisFixture(LEARNING_REPO);
    store.saveSnapshot(snapshot);
    store.saveAnalysis(analyzeSnapshot(snapshot, sources));
    store.deleteSnapshot(snapshot.id);
    expect(store.getAnalysis(snapshot.id)).toBeNull();
  });

  it("follows an allowed local config extension within the same download budget", async () => {
    const contents = {
      ...LEARNING_REPO,
      "tsconfig.json": '{ "extends": "./config/base.json" }',
      "config/base.json": LEARNING_REPO["tsconfig.json"].replace(
        '"baseUrl": "."',
        '"baseUrl": ".."',
      ),
    };
    const { snapshot } = analysisFixture(contents, []);
    store.saveSnapshot(snapshot);
    const { client, fetcher } = clientFor(contents);
    await buildStructuralAnalysis(snapshot.id, store, client, { fetchMissing: true, batchSize: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store.allSources(snapshot.id).map((source) => source.path)).toContain(
      "config/base.json",
    );
  });
});
