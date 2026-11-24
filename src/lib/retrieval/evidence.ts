import { createHash } from "node:crypto";
import type { EvidenceExcerpt } from "@/lib/contracts/overview";
import { sourceLines, type RepositorySnapshot, type SourceFile } from "@/lib/contracts/repository";
import { classifyEntry, containsLikelySecret } from "@/lib/github/filter";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function verifiedSources(snapshot: RepositorySnapshot, sources: SourceFile[]) {
  return sources.filter((source) => {
    const entry = snapshot.files.find((file) => file.id === source.fileId);
    if (
      !entry ||
      entry.status !== "fetched" ||
      source.snapshotId !== snapshot.id ||
      source.path !== entry.path
    )
      return false;
    if (
      classifyEntry({ ...entry, type: "blob", mode: "100644" }).reason ||
      containsLikelySecret(source.content)
    )
      return false;
    if (/(?:^|\/)(?:AGENTS|GEMINI|CLAUDE)\.md$/i.test(source.path)) return false;
    if (
      digest(source.content) !== source.contentHash ||
      sourceLines(source.content).length !== source.lineCount
    )
      return false;
    const bytes = Buffer.from(source.content);
    return (
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === entry.sha
    );
  });
}

export function excerptFrom(
  source: SourceFile,
  startLine: number,
  maxLines: number,
  maxBytes: number,
): EvidenceExcerpt | null {
  const all = sourceLines(source.content);
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > all.length) return null;
  const lines: string[] = [];
  for (const line of all.slice(startLine - 1, startLine - 1 + maxLines)) {
    if (Buffer.byteLength([...lines, line].join("\n")) > maxBytes) break;
    lines.push(line);
  }
  if (!lines.length || !lines.some((line) => line.trim())) return null;
  const endLine = startLine + lines.length - 1;
  return {
    id: `ev_${digest(`${source.fileId}:${source.contentHash}:${startLine}:${endLine}`).slice(0, 24)}`,
    fileId: source.fileId,
    path: source.path,
    contentHash: source.contentHash,
    startLine,
    endLine,
    text: lines.join("\n"),
    wholeFile: startLine === 1 && endLine === all.length,
  };
}
