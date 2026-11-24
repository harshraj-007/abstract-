import {
  overviewContentSchema,
  type EvidenceExcerpt,
  type OverviewClaim,
  type OverviewContent,
} from "@/lib/contracts/overview";
import { ExplorerError } from "@/lib/github/errors";

export function assertGroundedClaims(claims: OverviewClaim[], evidence: EvidenceExcerpt[]) {
  const allowed = new Set(evidence.map((item) => item.id));
  for (const claim of claims) {
    if (
      claim.evidenceIds.some((id) => !allowed.has(id)) ||
      new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
      (claim.status !== "unknown" && !claim.evidenceIds.length) ||
      (claim.status !== "observed" && !claim.limitation.trim())
    )
      throw new ExplorerError(
        "AI_INVALID_REFERENCES",
        "The AI response failed source-reference validation. It was not saved; previous answers remain available.",
        502,
      );
  }
}

export function validateOverview(output: unknown, evidence: EvidenceExcerpt[]): OverviewContent {
  const parsed = overviewContentSchema.safeParse(output);
  const invalid = () =>
    new ExplorerError(
      "AI_INVALID_REFERENCES",
      "Gemini's overview failed source-reference or response validation. It was not saved. The previous result is still available.",
      502,
    );
  if (!parsed.success) throw invalid();
  const allowed = new Set(evidence.map((item) => item.id));
  const content = parsed.data;
  assertGroundedClaims(
    [
      content.purpose,
      ...content.stack,
      ...content.modules.map((item) => item.explanation),
      ...content.architecture,
      ...content.readingOrder.map((item) => item.reason),
    ],
    evidence,
  );
  for (const item of content.readingOrder) {
    if (!allowed.has(item.evidenceId) || !item.reason.evidenceIds.includes(item.evidenceId))
      throw invalid();
  }
  if (
    new Set(content.readingOrder.map((item) => item.evidenceId)).size !==
    content.readingOrder.length
  )
    throw invalid();
  return content;
}
