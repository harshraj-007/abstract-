import { z } from "zod";
import { claimSchema, type EvidenceExcerpt, type OverviewReport } from "./overview";
import type { RepositorySnapshot } from "./repository";

export const QUESTION_VERSION = "question-v1";
export const QUESTION_OUTPUT_TOKENS = { quick: 2200, learn: 4000, deep: 6000 } as const;
export const QUESTION_READ_BATCH = 4;
export const questionDraftSchema = z
  .object({
    question: z.string().trim().min(1).max(1000),
    fileId: z.string().regex(/^[a-f0-9]{24}$/),
    line: z.number().int().min(1).max(2000000).optional(),
    depth: z.enum(["quick", "learn", "deep"]),
  })
  .strict();
export type QuestionDraft = z.infer<typeof questionDraftSchema>;
export const questionContentSchema = z
  .object({
    answer: claimSchema,
    steps: z
      .array(
        z.object({ title: z.string().trim().min(1).max(100), explanation: claimSchema }).strict(),
      )
      .max(8),
    takeaway: claimSchema,
    concepts: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            explanation: z.string().trim().min(1).max(1400),
          })
          .strict(),
      )
      .max(5),
    limitations: z.array(z.string().trim().min(1).max(1400)).min(1).max(12),
  })
  .strict();
export type QuestionContent = z.infer<typeof questionContentSchema>;
export type QuestionReport = Omit<OverviewReport, "content"> & {
  draft: QuestionDraft;
  path: string;
  content: QuestionContent;
};
export type QuestionSummary = Pick<QuestionReport, "id" | "createdAt" | "draft" | "path" | "model">;
export type QuestionPreview = {
  draft: QuestionDraft;
  path: string;
  configuration: { ready: boolean; model: string | null; missing: string[] };
  canGenerate: boolean;
  prerequisite: string | null;
  evidence: EvidenceExcerpt[];
  evidenceFingerprint?: string;
  payloadBytes: number;
  limitations: string[];
  report: QuestionReport | null;
  stale: boolean;
  retryAt?: string;
  cacheHit?: boolean;
};
export type QuestionReadResult = {
  snapshot: RepositorySnapshot;
  attempted: number;
  failures: { path: string; code: string; message: string }[];
};
