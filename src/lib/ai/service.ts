import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analysisFingerprint } from "@/lib/analysis/analyze";
import {
  GENERATION_SETTINGS,
  OVERVIEW_VERSION,
  overviewContentSchema,
  type EvidenceBundle,
  type OverviewReport,
  type OverviewState,
} from "@/lib/contracts/overview";
import { ExplorerError } from "@/lib/github/errors";
import { digest, packOverviewEvidence } from "@/lib/retrieval/overview";
import type { SnapshotStore } from "@/lib/storage/snapshots";
import { loadTutorPolicy, OVERVIEW_INSTRUCTION, PROMPT_VERSION, type TutorPolicy } from "./policy";
import {
  GeminiProvider,
  getGeminiConfiguration,
  type OverviewProvider,
  type GeminiEnvironment,
} from "./provider";
import { validateOverview } from "./validate";
import { GenerationGate, generationGate } from "./gate";

export const overviewJsonSchema = z.toJSONSchema(overviewContentSchema, { target: "draft-7" });
delete overviewJsonSchema.$schema;

function cacheKey(bundle: EvidenceBundle, model: string, policy: TutorPolicy) {
  return digest(
    JSON.stringify({
      evidence: bundle.fingerprint,
      analysis: bundle.analysisFingerprint,
      model,
      provider: "gemini-generateContent-v1beta",
      policy: policy.hash,
      prompt: PROMPT_VERSION,
      version: OVERVIEW_VERSION,
      settings: GENERATION_SETTINGS,
      schema: overviewJsonSchema,
    }),
  );
}

export class OverviewService {
  private readonly gate: GenerationGate;
  constructor(
    private readonly dependencies: {
      env?: () => GeminiEnvironment;
      policy?: () => Promise<TutorPolicy>;
      provider?: (key: string) => OverviewProvider;
      gate?: GenerationGate;
    } = {},
  ) {
    this.gate = dependencies.gate ?? new GenerationGate();
  }

  private async prepare(snapshotId: string, store: SnapshotStore) {
    const snapshot = store.getSnapshot(snapshotId);
    if (!snapshot)
      throw new ExplorerError(
        "SNAPSHOT_NOT_FOUND",
        "Snapshot not found. Open the repository again.",
        404,
      );
    const configuration = getGeminiConfiguration(this.dependencies.env?.() ?? process.env);
    const policy = await (this.dependencies.policy ?? loadTutorPolicy)();
    const analysis = store.getAnalysis(snapshotId);
    const sources = store.allSources(snapshotId);
    const current = analysis && analysis.fingerprint === analysisFingerprint(snapshot, sources);
    const bundle = current ? packOverviewEvidence(snapshot, analysis, sources) : null;
    const key =
      bundle && configuration.model ? cacheKey(bundle, configuration.model, policy) : null;
    const report =
      (key ? store.getOverview(snapshotId, key) : null) ?? store.getOverview(snapshotId);
    const prerequisite = !analysis
      ? "Build an architecture map from downloaded source first."
      : !current
        ? "Rebuild the architecture map to include the current downloaded source first."
        : !analysis.coverage.parsedFiles || !bundle?.excerpts.length
          ? "Read and map some supported source before generating an explanation."
          : null;
    const stale = Boolean(
      report &&
      (!bundle ||
        report.evidenceFingerprint !== bundle.fingerprint ||
        report.analysisFingerprint !== analysis?.fingerprint ||
        report.policyHash !== policy.hash ||
        report.version !== OVERVIEW_VERSION ||
        report.promptVersion !== PROMPT_VERSION ||
        (key && report.cacheKey !== key)),
    );
    const state: OverviewState = {
      report,
      stale,
      configuration,
      canGenerate: !prerequisite && configuration.ready,
      prerequisite,
      evidence: bundle?.excerpts ?? [],
      evidenceFingerprint: bundle?.fingerprint,
      payloadBytes: bundle?.payloadBytes ?? 0,
      omittedFiles: bundle?.omittedFiles ?? sources.length,
      limitations: [...(bundle?.limitations ?? []), ...(analysis?.limitations ?? [])],
      ...(this.gate.retryAt ? { retryAt: this.gate.retryAt } : {}),
    };
    return { state, bundle, key, policy, analysis, snapshot };
  }

  async getState(snapshotId: string, store: SnapshotStore): Promise<OverviewState> {
    return (await this.prepare(snapshotId, store)).state;
  }

  async generate(
    snapshotId: string,
    store: SnapshotStore,
    options: { evidenceFingerprint: string; signal?: AbortSignal },
  ): Promise<OverviewState> {
    const { state, bundle, key, policy, analysis, snapshot } = await this.prepare(
      snapshotId,
      store,
    );
    if (state.prerequisite || !bundle || !analysis)
      throw new ExplorerError(
        "AI_EVIDENCE_REQUIRED",
        state.prerequisite ?? "No source evidence is available.",
        409,
      );
    if (options.evidenceFingerprint !== bundle.fingerprint)
      throw new ExplorerError(
        "AI_EVIDENCE_CHANGED",
        "The evidence changed after your preview. Refresh the overview before sharing the updated excerpts.",
        409,
      );
    if (key) {
      const cached = store.getOverview(snapshotId, key);
      if (cached) return { ...state, report: cached, stale: false, cacheHit: true };
    }
    if (!state.configuration.ready || !state.configuration.model || !key)
      throw new ExplorerError(
        "AI_CONFIGURATION",
        `Configure ${state.configuration.missing.join(" and ")} on the server, then restart Abstract. The explorer and map work without Gemini.`,
        503,
      );
    const model = state.configuration.model;
    const started = Date.now();
    return this.gate.run(snapshotId, options.signal, async () => {
      const env = this.dependencies.env?.() ?? process.env;
      const provider =
        this.dependencies.provider?.(env.GEMINI_API_KEY!.trim()) ??
        new GeminiProvider(env.GEMINI_API_KEY!.trim());
      const system = `${policy.text}\n\n${OVERVIEW_INSTRUCTION}`;
      // Includes trusted policy, schema, and source; token usage is provider-reported, not inferred from bytes.
      if (
        Buffer.byteLength(
          JSON.stringify({ system, evidence: bundle.userText, schema: overviewJsonSchema }),
        ) > 96000
      )
        throw new ExplorerError(
          "AI_BUDGET",
          "The overview request exceeds its configured byte budget.",
          413,
        );
      const generated = await provider.generate({
        model,
        system,
        evidence: bundle.userText,
        schema: overviewJsonSchema,
        ...GENERATION_SETTINGS,
        signal: options.signal,
      });
      if (options.signal?.aborted)
        throw new ExplorerError(
          "CANCELLED",
          "Overview generation stopped. The previous report is preserved.",
          499,
        );
      const content = validateOverview(generated.output, bundle.excerpts);
      const latest = store.getSnapshot(snapshotId);
      if (
        !latest ||
        analysisFingerprint(latest, store.allSources(snapshotId)) !== analysis.fingerprint
      )
        throw new ExplorerError(
          "AI_EVIDENCE_CHANGED",
          "Source changed during generation. This output was not saved; rebuild the map before trying again.",
          409,
        );
      const report: OverviewReport = {
        id: randomUUID(),
        snapshotId,
        commit: snapshot.commit,
        cacheKey: key,
        createdAt: new Date().toISOString(),
        provider: "gemini",
        model,
        ...(generated.modelVersion ? { modelVersion: generated.modelVersion } : {}),
        promptVersion: PROMPT_VERSION,
        policyHash: policy.hash,
        version: OVERVIEW_VERSION,
        analysisFingerprint: analysis.fingerprint,
        evidenceFingerprint: bundle.fingerprint,
        content,
        evidence: bundle.excerpts,
        coverage: analysis.coverage,
        limitations: state.limitations,
        usage: generated.usage,
        durationMs: Date.now() - started,
      };
      store.saveOverview(report);
      return {
        ...state,
        report,
        stale: false,
        cacheHit: false,
        retryAt: this.gate.retryAt,
      };
    });
  }
}

export const overviewService = new OverviewService({ gate: generationGate });
