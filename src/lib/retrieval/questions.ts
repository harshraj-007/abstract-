import type { StructuralAnalysis } from "@/lib/contracts/analysis";
import type { EvidenceBundle, EvidenceExcerpt } from "@/lib/contracts/overview";
import { QUESTION_VERSION, type QuestionDraft } from "@/lib/contracts/questions";
import type { RepositorySnapshot, SourceFile } from "@/lib/contracts/repository";
import { ExplorerError } from "@/lib/github/errors";
import { digest, excerptFrom, verifiedSources } from "./evidence";

export const QUESTION_EVIDENCE_LIMITS = {
  excerpts: 8,
  lines: 100,
  excerptBytes: 6000,
  payloadBytes: 32000,
} as const;

export function packQuestionEvidence(
  snapshot: RepositorySnapshot,
  analysis: StructuralAnalysis,
  sources: SourceFile[],
  draft: QuestionDraft,
): EvidenceBundle {
  const safe = verifiedSources(snapshot, sources);
  const focus = safe.find((source) => source.fileId === draft.fileId);
  if (!focus || !focus.lineCount)
    throw new ExplorerError(
      "AI_EVIDENCE_REQUIRED",
      "Read a nonempty, permitted source file before asking about it.",
      409,
    );
  if (draft.line && draft.line > focus.lineCount)
    throw new ExplorerError(
      "INVALID_QUESTION_SCOPE",
      "The selected line is outside this file. Choose an existing line.",
      400,
    );
  const words = [...new Set(draft.question.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])]
    .filter(
      (word) =>
        ![
          "the",
          "this",
          "that",
          "how",
          "what",
          "why",
          "does",
          "with",
          "from",
          "file",
          "code",
          "function",
          "explain",
          "please",
        ].includes(word),
    )
    .slice(0, 12);
  const focusParsed = analysis.files.find((file) => file.fileId === focus.fileId);
  const symbol = focusParsed?.symbols.find(
    (item) =>
      item.name.length >= 3 && draft.question.toLowerCase().includes(item.name.toLowerCase()),
  );
  const anchor = draft.line ?? symbol?.source.startLine ?? 1;
  const outgoing = new Set(
    analysis.edges.filter((edge) => edge.from === focus.fileId).map((edge) => edge.to),
  );
  const incoming = new Set(
    analysis.edges.filter((edge) => edge.to === focus.fileId).map((edge) => edge.from),
  );
  const limitations = [
    "Answers use bounded cached excerpts and static references, not observed runtime execution. Reference checks do not establish factual accuracy.",
    "Saved answers are not automatically sent as conversation context; each question must state the context it needs.",
    ...analysis.limitations,
  ];
  const excerpts: EvidenceExcerpt[] = [];
  function payload(items: EvidenceExcerpt[]) {
    return JSON.stringify({
      task: "question",
      question: draft.question,
      depth: draft.depth,
      scope: { path: focus!.path, line: draft.line ?? null },
      repository: { owner: snapshot.owner, name: snapshot.name, commit: snapshot.commit },
      structuralCoverage: analysis.coverage,
      evidence: items.map((item) => ({
        id: item.id,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        wholeFile: item.wholeFile,
        numberedSource: item.text
          .split("\n")
          .map((line, index) => `${item.startLine + index}: ${line}`)
          .join("\n"),
        references: (analysis.files.find((file) => file.fileId === item.fileId)?.imports ?? [])
          .filter(
            (reference) =>
              reference.source.startLine >= item.startLine &&
              reference.source.endLine <= item.endLine,
          )
          .slice(0, 8)
          .map((reference) => ({
            specifier: reference.specifier,
            form: reference.form,
            typeOnly: reference.typeOnly,
            resolution: reference.resolution,
          })),
      })),
      unreadDirectTargets: snapshot.files
        .filter(
          (file) => outgoing.has(file.id) && !safe.some((source) => source.fileId === file.id),
        )
        .slice(0, 8)
        .map((file) => file.path),
      limitations: limitations.slice(0, 20),
    });
  }
  function add(source: SourceFile, start: number) {
    if (excerpts.length >= QUESTION_EVIDENCE_LIMITS.excerpts) return false;
    const item = excerptFrom(
      source,
      start,
      QUESTION_EVIDENCE_LIMITS.lines,
      QUESTION_EVIDENCE_LIMITS.excerptBytes,
    );
    if (
      !item ||
      excerpts.some((existing) => existing.id === item.id) ||
      Buffer.byteLength(payload([...excerpts, item])) > QUESTION_EVIDENCE_LIMITS.payloadBytes
    )
      return false;
    excerpts.push(item);
    return true;
  }
  add(focus, Math.max(1, anchor - 10));
  if (!excerpts.some((item) => item.startLine <= anchor && item.endLine >= anchor)) {
    excerpts.length = 0;
    add(focus, anchor);
  }
  if (!excerpts.length)
    throw new ExplorerError(
      "AI_EVIDENCE_REQUIRED",
      "The selected line cannot fit into a safe source excerpt. Choose another source line.",
      409,
    );
  if (excerpts[0].startLine > 30) add(focus, 1);
  function lexicalScore(source: SourceFile) {
    return words.reduce(
      (sum, word) =>
        sum +
        (source.path.toLowerCase().includes(word)
          ? 8
          : source.content.toLowerCase().includes(word)
            ? 2
            : 0),
      0,
    );
  }
  const ranked = safe
    .filter((source) => source.fileId !== focus.fileId)
    .map((source) => ({
      source,
      score:
        (outgoing.has(source.fileId)
          ? 100
          : incoming.has(source.fileId)
            ? 70
            : source.path === "package.json"
              ? 10
              : 0) + lexicalScore(source),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.source.path.localeCompare(b.source.path));
  for (const { source } of ranked) {
    const match = analysis.files
      .find((file) => file.fileId === source.fileId)
      ?.symbols.find((item) => words.some((word) => item.name.toLowerCase().includes(word)));
    add(source, Math.max(1, (match?.source.startLine ?? 1) - 10));
  }
  const userText = payload(excerpts);
  const omittedFiles = Math.max(
    0,
    sources.length - new Set(excerpts.map((item) => item.fileId)).size,
  );
  return {
    version: QUESTION_VERSION,
    analysisFingerprint: analysis.fingerprint,
    fingerprint: digest(userText),
    excerpts,
    userText,
    payloadBytes: Buffer.byteLength(userText),
    omittedFiles,
    limitations: [
      ...limitations,
      `${excerpts.length} excerpts were supplied; ${omittedFiles} other cached files were omitted. Files may be excerpted.`,
    ],
  };
}
