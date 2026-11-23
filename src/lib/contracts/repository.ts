export const INGESTION_VERSION = "explorer-v1";

export const DEFAULT_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxTreeEntries: 10_000,
} as const;

export type SkipReason =
  "generated" | "sensitive" | "binary" | "unsupported" | "oversized" | "budget";
export type FileStatus = "available" | "fetched" | "skipped" | "failed";

export type SourceEntry = {
  id: string;
  path: string;
  sha: string;
  size: number;
  status: FileStatus;
  reason?: SkipReason;
  detail?: string;
};

export type RepositorySnapshot = {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  commit: string;
  language: string | null;
  createdAt: string;
  ingestionVersion: string;
  discoveryComplete: boolean;
  limitations: string[];
  files: SourceEntry[];
  limits: typeof DEFAULT_LIMITS;
};

export type SourceFile = {
  snapshotId: string;
  fileId: string;
  path: string;
  content: string;
  contentHash: string;
  lineCount: number;
};

export type SnapshotSummary = Pick<
  RepositorySnapshot,
  "id" | "owner" | "name" | "commit" | "createdAt" | "language"
>;
export type ProgressStage = "resolving" | "fetching" | "indexing" | "saving";
export type ApiError = { code: string; message: string; retryAt?: string };

export type ImportEvent =
  | { type: "progress"; stage: ProgressStage; message: string }
  | { type: "complete"; snapshot: RepositorySnapshot }
  | { type: "error"; error: ApiError };

export function sourceLines(content: string): string[] {
  if (!content.length) return [];
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function coverageOf(snapshot: RepositorySnapshot) {
  const files = snapshot.files;
  return {
    discovered: files.length,
    selected: files.filter(
      (file) =>
        file.status === "available" || file.status === "fetched" || file.status === "failed",
    ).length,
    fetched: files.filter((file) => file.status === "fetched").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    failed: files.filter((file) => file.status === "failed").length,
    selectedBytes: files
      .filter((file) => file.status !== "skipped")
      .reduce((sum, file) => sum + file.size, 0),
  };
}

export function sourceUrl(
  snapshot: Pick<RepositorySnapshot, "owner" | "name" | "commit">,
  path?: string,
  line?: number,
) {
  const root = `https://github.com/${encodeURIComponent(snapshot.owner)}/${encodeURIComponent(snapshot.name)}`;
  const target = path
    ? `blob/${snapshot.commit}/${path.split("/").map(encodeURIComponent).join("/")}`
    : `tree/${snapshot.commit}`;
  return `${root}/${target}${line ? `#L${line}` : ""}`;
}
