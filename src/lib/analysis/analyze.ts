import { createHash } from "node:crypto";
import type { RepositorySnapshot, SourceFile } from "@/lib/contracts/repository";
import { ANALYZER_VERSION, type StructuralAnalysis } from "@/lib/contracts/analysis";
import { readConfiguration } from "./configuration";
import { isCodePath, parseSource, stableId } from "./parser";
import { createResolver } from "./resolver";
import { discoverNextEntries } from "./nextjs";

export function analysisFingerprint(snapshot: RepositorySnapshot, sources: SourceFile[]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: ANALYZER_VERSION,
        commit: snapshot.commit,
        source: sources
          .map((source) => [source.fileId, source.contentHash])
          .sort((a, b) => a[0].localeCompare(b[0])),
        manifest: snapshot.files.map((file) => [
          file.id,
          file.sha,
          file.status === "skipped" ? file.reason : "eligible",
        ]),
      }),
    )
    .digest("hex");
}

function folderOf(filename: string) {
  const parts = filename.split("/");
  return parts.length === 1
    ? "(root)"
    : parts[0] === "src" && parts.length > 2
      ? parts.slice(0, 2).join("/")
      : parts[0];
}

export function analyzeSnapshot(
  snapshot: RepositorySnapshot,
  input: SourceFile[],
  downloadFailures: StructuralAnalysis["downloadFailures"] = [],
): StructuralAnalysis {
  const manifest = new Map(snapshot.files.map((file) => [file.id, file]));
  const sources = input.filter(
    (source) =>
      source.snapshotId === snapshot.id &&
      manifest.get(source.fileId)?.path === source.path &&
      manifest.get(source.fileId)?.status !== "skipped",
  );
  const configuration = readConfiguration(
    sources,
    snapshot.files.map((file) => file.path),
  );
  const resolve = createResolver(snapshot, sources, configuration);
  const files = sources
    .filter((source) => isCodePath(source.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(parseSource);
  for (const file of files) file.imports = file.imports.map(resolve);
  const next = discoverNextEntries(snapshot, files, sources, configuration);
  const candidates = snapshot.files.filter(
    (file) => file.status !== "skipped" && isCodePath(file.path),
  );
  const references = files.flatMap((file) => file.imports);
  const edges = references
    .filter((reference) => reference.resolution === "internal" && reference.targetFileId)
    .map((reference) => ({
      id: stableId(reference.id, reference.targetFileId!),
      from: reference.source.fileId,
      to: reference.targetFileId!,
      referenceId: reference.id,
      form: reference.form,
      typeOnly: reference.typeOnly,
      source: reference.source,
    }));
  const syntaxErrors = files.filter((file) => file.status === "syntax-error").length;
  const unresolved = references.filter((reference) => reference.resolution === "unresolved").length;
  const limitations = [...configuration.limitations, ...next.limitations];
  const unread = candidates.length - files.length;
  if (unread)
    limitations.push(
      `${unread} selected source files have not been read. Their imports and symbols are not known yet.`,
    );
  if (!snapshot.discoveryComplete)
    limitations.push(
      "Repository discovery was partial; this map cannot account for undiscovered files.",
    );
  if (syntaxErrors)
    limitations.push(
      `${syntaxErrors} files have syntax errors and contribute no verified dependency edges.`,
    );
  if (unresolved)
    limitations.push(
      `${unresolved} module references are unresolved. These are shown explicitly instead of inventing targets.`,
    );
  if (downloadFailures.length)
    limitations.push(
      "Some source downloads failed or were excluded. Successfully read source is still included; retry later to expand the map.",
    );
  if (!files.length)
    limitations.push(
      "No supported JavaScript/TypeScript source has been parsed yet. Read source files to build a useful map.",
    );
  limitations.push(
    "Arrows show observed module references, including re-exports and literal dynamic imports. They are not function-call traces or proof of runtime behavior.",
  );
  limitations.push(
    "Symbol extraction covers top-level identifier declarations and class methods. Nested local declarations, CommonJS resolution, workspace packages and runtime data flows are outside this version.",
  );
  const groupMap = new Map<string, string[]>();
  for (const file of candidates)
    groupMap.set(folderOf(file.path), [...(groupMap.get(folderOf(file.path)) ?? []), file.id]);
  const parsedIds = new Set(
    files.filter((file) => file.status === "parsed").map((file) => file.fileId),
  );
  const fingerprint = analysisFingerprint(snapshot, sources);
  const partial =
    !files.length ||
    unread > 0 ||
    syntaxErrors > 0 ||
    unresolved > 0 ||
    !snapshot.discoveryComplete ||
    downloadFailures.length > 0 ||
    configuration.limitations.length > 0 ||
    next.limitations.length > 0 ||
    files.some((file) => file.diagnostics.length > 0);
  return {
    id: stableId(snapshot.id, fingerprint),
    snapshotId: snapshot.id,
    commit: snapshot.commit,
    analyzerVersion: ANALYZER_VERSION,
    fingerprint,
    createdAt: new Date().toISOString(),
    status: partial ? "partial" : "ready",
    framework: next.framework,
    coverage: {
      candidateFiles: candidates.length,
      parsedFiles: parsedIds.size,
      syntaxErrorFiles: syntaxErrors,
      unreadFiles: unread,
      symbolCount: files.reduce((sum, file) => sum + file.symbols.length, 0),
      internalReferences: edges.length,
      externalReferences: references.filter((reference) => reference.resolution === "external")
        .length,
      unresolvedReferences: unresolved,
    },
    files,
    edges,
    entryPoints: next.entryPoints,
    groups: [...groupMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, fileIds]) => ({
        name,
        fileIds,
        parsedCount: fileIds.filter((id) => parsedIds.has(id)).length,
      })),
    limitations: [...new Set(limitations)],
    downloadFailures,
  };
}
