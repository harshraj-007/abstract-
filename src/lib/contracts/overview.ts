import { z } from "zod";
import type { SourceLocation, StructuralAnalysis } from "./analysis";

export const OVERVIEW_VERSION = "overview-v1";
export const GENERATION_SETTINGS = { maxOutputTokens: 6000, gemini3ThinkingLevel: "LOW" } as const;
const text = z.string().trim().min(1).max(1400);
export const claimSchema = z
  .object({
    text,
    status: z.enum(["observed", "inferred", "unknown"]),
    evidenceIds: z.array(z.string().min(1).max(64)).max(8),
    limitation: z.string().trim().max(800),
  })
  .strict();
export const overviewContentSchema = z
  .object({
    purpose: claimSchema,
    stack: z.array(claimSchema).max(8),
    modules: z
      .array(z.object({ name: z.string().min(1).max(100), explanation: claimSchema }).strict())
      .max(8),
    architecture: z.array(claimSchema).max(8),
    readingOrder: z
      .array(z.object({ evidenceId: z.string().min(1).max(64), reason: claimSchema }).strict())
      .min(1)
      .max(8),
    concepts: z
      .array(z.object({ name: z.string().min(1).max(100), explanation: text }).strict())
      .max(5),
    limitations: z.array(text).min(1).max(12),
  })
  .strict();

export type OverviewContent = z.infer<typeof overviewContentSchema>;
export type OverviewClaim = z.infer<typeof claimSchema>;
export type EvidenceExcerpt = SourceLocation & { id: string; text: string; wholeFile: boolean };
export type EvidenceBundle = {
  version: string;
  fingerprint: string;
  analysisFingerprint: string;
  excerpts: EvidenceExcerpt[];
  userText: string;
  payloadBytes: number;
  omittedFiles: number;
  limitations: string[];
};
export type Usage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type OverviewReport = {
  id: string;
  snapshotId: string;
  commit: string;
  cacheKey: string;
  createdAt: string;
  provider: "gemini";
  model: string;
  modelVersion?: string;
  promptVersion: string;
  policyHash: string;
  version: string;
  analysisFingerprint: string;
  evidenceFingerprint: string;
  content: OverviewContent;
  evidence: EvidenceExcerpt[];
  coverage: StructuralAnalysis["coverage"];
  limitations: string[];
  usage: Usage;
  durationMs: number;
};
export type OverviewState = {
  report: OverviewReport | null;
  stale: boolean;
  configuration: { ready: boolean; model: string | null; missing: string[] };
  canGenerate: boolean;
  prerequisite: string | null;
  evidence: EvidenceExcerpt[];
  evidenceFingerprint?: string;
  payloadBytes: number;
  omittedFiles: number;
  limitations: string[];
  cacheHit?: boolean;
  retryAt?: string;
};
