import type { StructuralAnalysis } from "@/lib/contracts/analysis";
import {
  OVERVIEW_VERSION,
  type EvidenceBundle,
  type EvidenceExcerpt,
} from "@/lib/contracts/overview";
import { sourceLines, type RepositorySnapshot, type SourceFile } from "@/lib/contracts/repository";
import { priorityOf } from "@/lib/github/filter";
import { digest, verifiedSources } from "./evidence";
export { digest } from "./evidence";

export const EVIDENCE_LIMITS = {
  excerpts: 12,
  linesPerExcerpt: 100,
  excerptBytes: 6000,
  payloadBytes: 48000,
} as const;

export function packOverviewEvidence(
  snapshot: RepositorySnapshot,
  analysis: StructuralAnalysis,
  sources: SourceFile[],
): EvidenceBundle {
  const entryIds = new Set(analysis.entryPoints.map((entry) => entry.fileId));
  const connections = new Map<string, number>();
  for (const edge of analysis.edges) connections.set(edge.to, (connections.get(edge.to) ?? 0) + 1);
  function rank(source: SourceFile) {
    if (/^readme\.md$/i.test(source.path)) return -100;
    if (source.path === "package.json") return -99;
    if (entryIds.has(source.fileId)) return -80;
    return priorityOf(source.path) - Math.min(connections.get(source.fileId) ?? 0, 10);
  }
  const eligible = verifiedSources(snapshot, sources).sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path),
  );
  const excerpts: EvidenceExcerpt[] = [];
  const limitations = [
    "Explanations use bounded cached excerpts. Source was not executed, and reference validation does not prove a model's interpretation is correct.",
  ];
  function payload(items: EvidenceExcerpt[]) {
    return JSON.stringify({
      task: "overview",
      repository: { owner: snapshot.owner, name: snapshot.name, commit: snapshot.commit },
      structuralCoverage: analysis.coverage,
      discoveryComplete: snapshot.discoveryComplete,
      // Tie every structural fact supplied to a visible supporting excerpt.
      evidence: items.map((excerpt) => {
        const parsed = analysis.files.find((file) => file.fileId === excerpt.fileId);
        const overlaps = (start: number, end: number) =>
          start >= excerpt.startLine && end <= excerpt.endLine;
        return {
          id: excerpt.id,
          path: excerpt.path,
          startLine: excerpt.startLine,
          endLine: excerpt.endLine,
          wholeFile: excerpt.wholeFile,
          numberedSource: excerpt.text
            .split("\n")
            .map((line, index) => `${index + excerpt.startLine}: ${line}`)
            .join("\n"),
          declarations: (parsed?.symbols ?? [])
            .filter((symbol) => overlaps(symbol.source.startLine, symbol.source.endLine))
            .slice(0, 12)
            .map((symbol) => ({ name: symbol.name, kind: symbol.kind, exported: symbol.exported })),
          references: (parsed?.imports ?? [])
            .filter((reference) => overlaps(reference.source.startLine, reference.source.endLine))
            .slice(0, 12)
            .map((reference) => ({
              specifier: reference.specifier,
              form: reference.form,
              typeOnly: reference.typeOnly,
              resolution: reference.resolution,
            })),
          entryPoints: analysis.entryPoints
            .filter(
              (entry) =>
                entry.fileId === excerpt.fileId &&
                overlaps(entry.source.startLine, entry.source.startLine),
            )
            .map((entry) => ({
              kind: entry.kind,
              routePattern: entry.routePath,
              exportedMethods: entry.methods,
            })),
        };
      }),
      limitations: [...limitations, ...analysis.limitations].slice(0, 20),
    });
  }
  for (const source of eligible) {
    if (excerpts.length >= EVIDENCE_LIMITS.excerpts) break;
    const all = sourceLines(source.content);
    if (!all.length) continue;
    // Start at the first entry point/export when a large file's preamble would obscure its implementation.
    const anchor =
      analysis.entryPoints.find((entry) => entry.fileId === source.fileId)?.source.startLine ?? 1;
    const start =
      all.length > EVIDENCE_LIMITS.linesPerExcerpt && anchor > 40 ? Math.max(1, anchor - 5) : 1;
    const lines: string[] = [];
    for (const line of all.slice(start - 1, start - 1 + EVIDENCE_LIMITS.linesPerExcerpt)) {
      if (Buffer.byteLength([...lines, line].join("\n")) > EVIDENCE_LIMITS.excerptBytes) break;
      lines.push(line);
    }
    if (!lines.length || !lines.some((line) => line.trim())) continue;
    const end = start + lines.length - 1;
    const excerpt: EvidenceExcerpt = {
      id: `ev_${digest(`${source.fileId}:${source.contentHash}:${start}:${end}`).slice(0, 24)}`,
      fileId: source.fileId,
      path: source.path,
      contentHash: source.contentHash,
      startLine: start,
      endLine: end,
      text: lines.join("\n"),
      wholeFile: start === 1 && end === all.length,
    };
    if (Buffer.byteLength(payload([...excerpts, excerpt])) <= EVIDENCE_LIMITS.payloadBytes)
      excerpts.push(excerpt);
  }
  const omittedFiles = Math.max(0, sources.length - excerpts.length);
  // Keep the final payload bounded too; limitations were present during selection.
  const userText = payload(excerpts);
  return {
    version: OVERVIEW_VERSION,
    analysisFingerprint: analysis.fingerprint,
    fingerprint: digest(userText),
    excerpts,
    userText,
    payloadBytes: Buffer.byteLength(userText),
    omittedFiles,
    limitations: [
      ...limitations,
      `${excerpts.length} cached files supplied as excerpts; ${omittedFiles} cached files not supplied. Some supplied files may be excerpted.`,
    ],
  };
}
