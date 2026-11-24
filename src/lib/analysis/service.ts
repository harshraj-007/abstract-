import path from "node:path";
import type { SnapshotStore } from "@/lib/storage/snapshots";
import type { GitHubClient } from "@/lib/github/client";
import { ExplorerError } from "@/lib/github/errors";
import { loadSource } from "@/lib/github/ingest";
import { priorityOf, isSafeRelativePath } from "@/lib/github/filter";
import {
  ANALYSIS_DOWNLOAD_BATCH,
  type AnalysisEvent,
  type AnalysisResult,
  type StructuralAnalysis,
} from "@/lib/contracts/analysis";
import type { SourceEntry, SourceFile } from "@/lib/contracts/repository";
import { analysisFingerprint, analyzeSnapshot } from "./analyze";
import { isCodePath } from "./parser";
import { readJsonSource } from "./configuration";

export function getAnalysisResult(snapshotId: string, store: SnapshotStore): AnalysisResult {
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot)
    throw new ExplorerError(
      "SNAPSHOT_NOT_FOUND",
      "Snapshot not found. Open the repository again.",
      404,
    );
  const analysis = store.getAnalysis(snapshotId);
  return {
    snapshot,
    analysis,
    stale: Boolean(
      analysis &&
      analysis.fingerprint !== analysisFingerprint(snapshot, store.allSources(snapshotId)),
    ),
  };
}

function analysisPriority(file: SourceEntry) {
  if (file.path === "package.json") return -4;
  if (["tsconfig.json", "jsconfig.json"].includes(file.path)) return -3;
  if (/^next\.config\.[cm]?[jt]s$/.test(file.path)) return -2;
  return priorityOf(file.path);
}

export async function buildStructuralAnalysis(
  snapshotId: string,
  store: SnapshotStore,
  client: GitHubClient,
  options: { fetchMissing: boolean; signal?: AbortSignal; batchSize?: number },
  progress: (event: Extract<AnalysisEvent, { type: "progress" }>) => void = () => {},
): Promise<AnalysisResult & { analysis: StructuralAnalysis }> {
  const initial = getAnalysisResult(snapshotId, store);
  const failures: StructuralAnalysis["downloadFailures"] = [];
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? ANALYSIS_DOWNLOAD_BATCH, ANALYSIS_DOWNLOAD_BATCH),
  );
  const sourceMap = new Map(store.allSources(snapshotId).map((source) => [source.fileId, source]));
  let queue = initial.snapshot.files
    .filter(
      (file) =>
        file.status !== "skipped" &&
        (isCodePath(file.path) ||
          ["package.json", "tsconfig.json", "jsconfig.json"].includes(file.path)),
    )
    .sort((a, b) => analysisPriority(a) - analysisPriority(b) || a.path.localeCompare(b.path));
  const visited = new Set<string>();
  const configDepth = new Map<string, number>([
    ["tsconfig.json", 0],
    ["jsconfig.json", 0],
  ]);
  function includeParentConfig(source: SourceFile) {
    const depth = configDepth.get(source.path);
    if (depth === undefined || depth >= 5) return;
    const extension = readJsonSource(source).value?.extends;
    if (typeof extension !== "string" || !extension.startsWith(".")) return;
    let filename = path.posix.normalize(
      path.posix.join(path.posix.dirname(source.path), extension),
    );
    if (!filename.endsWith(".json")) filename += ".json";
    if (!isSafeRelativePath(filename) || configDepth.has(filename)) return;
    configDepth.set(filename, depth + 1);
    const entry = initial.snapshot.files.find(
      (file) => file.path === filename && file.status !== "skipped",
    );
    if (!entry) return;
    const cached = sourceMap.get(entry.id);
    if (cached) includeParentConfig(cached);
    else queue = [entry, ...queue.filter((file) => file.id !== entry.id)];
  }
  for (const source of sourceMap.values()) includeParentConfig(source);
  let attempted = 0;
  const total = Math.min(batchSize, queue.filter((file) => !sourceMap.has(file.id)).length);

  if (options.fetchMissing) {
    while (queue.length && attempted < batchSize) {
      if (options.signal?.aborted)
        throw new ExplorerError(
          "CANCELLED",
          "Map building stopped. Downloaded source is still saved.",
          499,
        );
      const entry = queue.shift()!;
      if (visited.has(entry.id) || sourceMap.has(entry.id)) continue;
      visited.add(entry.id);
      attempted++;
      progress({
        type: "progress",
        stage: "reading",
        completed: attempted - 1,
        total: Math.max(total, attempted),
        message: `Reading ${entry.path} (${attempted} of up to ${batchSize} new files)…`,
      });
      try {
        const result = await loadSource(snapshotId, entry.id, client, store);
        sourceMap.set(entry.id, result.source);
        includeParentConfig(result.source);
      } catch (error) {
        if (!(error instanceof ExplorerError)) throw error;
        if (error.code === "CANCELLED" || options.signal?.aborted) throw error;
        failures.push({ fileId: entry.id, code: error.code, message: error.message });
        if (
          ["RATE_LIMITED", "GITHUB_UNREACHABLE", "GITHUB_AUTH", "ACCESS_DENIED"].includes(
            error.code,
          )
        )
          break;
      }
    }
  }
  if (options.signal?.aborted)
    throw new ExplorerError(
      "CANCELLED",
      "Map building stopped. Downloaded source is still saved.",
      499,
    );
  const current = store.getSnapshot(snapshotId);
  if (!current)
    throw new ExplorerError(
      "SNAPSHOT_NOT_FOUND",
      "The snapshot was removed while building its map.",
      404,
    );
  const sources = store.allSources(snapshotId);
  if (
    !failures.length &&
    initial.analysis &&
    initial.analysis.fingerprint === analysisFingerprint(current, sources)
  )
    return { snapshot: current, analysis: initial.analysis, stale: false };
  progress({
    type: "progress",
    stage: "parsing",
    completed: attempted,
    total: Math.max(total, attempted),
    message: "Parsing source and resolving module references inside the snapshot…",
  });
  const analysis = analyzeSnapshot(current, sources, failures);
  progress({
    type: "progress",
    stage: "saving",
    completed: attempted,
    total: Math.max(total, attempted),
    message: "Saving the source-linked structural map…",
  });
  store.saveAnalysis(analysis);
  return { analysis, snapshot: current, stale: false };
}
