import { ExplorerError } from "@/lib/github/errors";

/** Shared by overview and questions in this local process, including their cooldown. */
export class GenerationGate {
  private active = new Set<string>();
  private cooldownUntil = 0;
  get retryAt() {
    return this.cooldownUntil > Date.now() ? new Date(this.cooldownUntil).toISOString() : undefined;
  }
  async run<T>(
    snapshotId: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted)
      throw new ExplorerError(
        "CANCELLED",
        "Generation stopped. Saved answers remain available.",
        499,
      );
    if (this.active.has(snapshotId) || this.active.size >= 2)
      throw new ExplorerError(
        "BUSY",
        "An AI task is already running for this snapshot or two snapshots are busy. Wait for it to finish.",
        429,
      );
    if (this.retryAt)
      throw new ExplorerError(
        "AI_RATE_LIMITED",
        "Wait before starting another Gemini request. Saved results remain available.",
        429,
        this.retryAt,
      );
    this.active.add(snapshotId);
    this.cooldownUntil = Date.now() + 30000;
    try {
      return await work();
    } catch (error) {
      if (error instanceof ExplorerError && error.retryAt) {
        const retry = Date.parse(error.retryAt);
        if (Number.isFinite(retry)) this.cooldownUntil = Math.max(this.cooldownUntil, retry);
      }
      throw error;
    } finally {
      this.active.delete(snapshotId);
    }
  }
}
export const generationGate = new GenerationGate();
