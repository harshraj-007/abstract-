import { randomUUID } from "node:crypto";
import {
  DEFAULT_LIMITS,
  INGESTION_VERSION,
  type ImportEvent,
  type RepositorySnapshot,
} from "@/lib/contracts/repository";
import { GitHubClient } from "./client";
import { parseRepositoryUrl } from "./url";
import { isSafeRelativePath, selectManifest } from "./filter";
import { ExplorerError } from "./errors";
import type { SnapshotStore } from "@/lib/storage/snapshots";

export async function ingestRepository(
  input: string,
  client: GitHubClient,
  store: SnapshotStore,
  progress: (event: Extract<ImportEvent, { type: "progress" }>) => void = () => {},
): Promise<RepositorySnapshot> {
  const { owner, name } = parseRepositoryUrl(input);
  progress({
    type: "progress",
    stage: "resolving",
    message: "Checking the public repository and resolving its default branch…",
  });
  const repository = await client.repository(owner, name);
  const commit = await client.commit(
    repository.owner.login,
    repository.name,
    repository.default_branch,
  );
  progress({
    type: "progress",
    stage: "fetching",
    message: `Reading the file tree at commit ${commit.sha.slice(0, 7)}…`,
  });
  const tree = await client.tree(repository.owner.login, repository.name, commit.commit.tree.sha);
  progress({
    type: "progress",
    stage: "indexing",
    message: "Selecting readable source files and recording exclusions…",
  });

  const discoveryComplete = !tree.truncated && tree.tree.length <= DEFAULT_LIMITS.maxTreeEntries;
  const limitations: string[] = [];
  if (tree.truncated)
    limitations.push(
      "GitHub returned a truncated file tree. Counts cover only discovered entries; undiscovered files are not included.",
    );
  if (tree.tree.length > DEFAULT_LIMITS.maxTreeEntries)
    limitations.push(
      `Only the first ${DEFAULT_LIMITS.maxTreeEntries.toLocaleString()} tree entries were inspected. Discovery is incomplete.`,
    );
  const safeEntries = tree.tree
    .slice(0, DEFAULT_LIMITS.maxTreeEntries)
    .filter((entry) => isSafeRelativePath(entry.path));
  if (safeEntries.length !== Math.min(tree.tree.length, DEFAULT_LIMITS.maxTreeEntries))
    limitations.push("Entries with unsupported source paths were omitted from the manifest.");
  const seen = new Set<string>();
  const files = selectManifest(
    safeEntries.filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    }),
  );
  if (files.length === 0 && discoveryComplete)
    throw new ExplorerError(
      "EMPTY_REPOSITORY",
      "This repository has no source files in its current commit.",
      409,
    );
  if (files.some((entry) => entry.reason === "budget"))
    limitations.push(
      "The selection is limited to 200 files and 2 MiB of source text. Additional files are listed as skipped.",
    );
  if (!files.some((entry) => entry.status === "available"))
    limitations.push(
      "No readable files were selected. Inspect the coverage list for exclusion reasons.",
    );
  limitations.push(
    "Source is downloaded and checked when opened. Structural maps can be partial. Optional AI explanations use bounded excerpts and require explicit source sharing.",
  );

  const snapshot: RepositorySnapshot = {
    id: randomUUID(),
    owner: repository.owner.login,
    name: repository.name,
    description: repository.description,
    defaultBranch: repository.default_branch,
    commit: commit.sha,
    language: repository.language,
    createdAt: new Date().toISOString(),
    ingestionVersion: INGESTION_VERSION,
    discoveryComplete,
    limitations,
    files,
    limits: { ...DEFAULT_LIMITS },
  };
  progress({
    type: "progress",
    stage: "saving",
    message: "Saving the pinned snapshot to your local workspace…",
  });
  store.saveSnapshot(snapshot);
  return snapshot;
}

export async function loadSource(
  snapshotId: string,
  fileId: string,
  client: GitHubClient,
  store: SnapshotStore,
) {
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot)
    throw new ExplorerError(
      "SNAPSHOT_NOT_FOUND",
      "This snapshot is no longer available. Open the repository again.",
      404,
    );
  const entry = snapshot.files.find((file) => file.id === fileId);
  if (!entry)
    throw new ExplorerError(
      "FILE_NOT_FOUND",
      "This file is not part of the selected snapshot.",
      404,
    );
  if (entry.status === "skipped")
    throw new ExplorerError(
      "FILE_EXCLUDED",
      entry.detail || "This file was excluded from the snapshot.",
      422,
    );
  const cached = store.getSource(snapshotId, fileId);
  if (cached) return { source: cached, snapshot, cached: true };
  try {
    const downloaded = await client.source(snapshot.owner, snapshot.name, entry.sha);
    if (downloaded.size !== entry.size)
      throw new ExplorerError(
        "SOURCE_MISMATCH",
        "Source size does not match the pinned manifest. The file was not saved.",
        502,
      );
    const source = {
      snapshotId,
      fileId,
      path: entry.path,
      content: downloaded.content,
      contentHash: downloaded.contentHash,
      lineCount: downloaded.lineCount,
    };
    store.saveSource(source);
    return { source, snapshot: store.getSnapshot(snapshotId)!, cached: false };
  } catch (error) {
    if (error instanceof ExplorerError && error.code !== "CANCELLED") {
      const reason =
        error.code === "SENSITIVE_SOURCE"
          ? "sensitive"
          : error.code === "BINARY_SOURCE"
            ? "binary"
            : error.code === "FILE_TOO_LARGE"
              ? "oversized"
              : undefined;
      store.updateEntry(snapshotId, fileId, {
        status: reason ? "skipped" : "failed",
        reason,
        detail: error.message,
      });
    }
    throw error;
  }
}
