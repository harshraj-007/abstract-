import { GENERATION_SETTINGS, type Usage } from "@/lib/contracts/overview";
import { ExplorerError } from "@/lib/github/errors";
import { z } from "zod";

const envelopeSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z
              .array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }))
              .max(100)
              .optional(),
          })
          .optional(),
      }),
    )
    .max(2)
    .optional(),
  modelVersion: z.string().max(150).optional(),
  usageMetadata: z.record(z.string(), z.unknown()).optional(),
});

export type OverviewProvider = {
  generate(input: {
    model: string;
    system: string;
    evidence: string;
    schema: Record<string, unknown>;
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<{ output: unknown; usage: Usage; modelVersion?: string }>;
};
export type GeminiEnvironment = Record<string, string | undefined>;
export function getGeminiConfiguration(env: GeminiEnvironment = process.env) {
  const model = env.GEMINI_MODEL?.trim() ?? "";
  const missing: string[] = [];
  if (!env.GEMINI_API_KEY?.trim()) missing.push("GEMINI_API_KEY");
  if (!model) missing.push("GEMINI_MODEL");
  else if (!/^gemini-[a-zA-Z0-9._-]{1,90}$/.test(model))
    missing.push("valid GEMINI_MODEL (a Gemini model ID, without a URL or models/ prefix)");
  return {
    ready: missing.length === 0,
    model: /^gemini-[a-zA-Z0-9._-]{1,90}$/.test(model) ? model : null,
    missing,
  };
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ExplorerError("AI_INVALID_OUTPUT", "Gemini returned no response body.", 502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        throw new ExplorerError(
          "AI_INVALID_OUTPUT",
          "Gemini's response exceeded the allowed size.",
          502,
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ExplorerError) throw error;
    throw new ExplorerError(
      "AI_INVALID_OUTPUT",
      "Gemini returned an unreadable response. The previous overview is preserved.",
      502,
    );
  } finally {
    reader.releaseLock();
  }
}

export class GeminiProvider implements OverviewProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async generate(input: Parameters<OverviewProvider["generate"]>[0]) {
    if (!/^gemini-[a-zA-Z0-9._-]{1,90}$/.test(input.model))
      throw new ExplorerError(
        "AI_CONFIGURATION",
        "Set a valid Gemini model ID on the server.",
        503,
      );
    const timeout = AbortSignal.timeout(120000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models/${input.model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
          signal,
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: "user", parts: [{ text: input.evidence }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: input.schema,
              maxOutputTokens: input.maxOutputTokens,
              candidateCount: 1,
              // Keep interactive overviews responsive on supported Gemini 3 text models.
              ...(/^gemini-3(?:[.-])/.test(input.model) && !/(?:image|tts|live)/i.test(input.model)
                ? { thinkingConfig: { thinkingLevel: GENERATION_SETTINGS.gemini3ThinkingLevel } }
                : {}),
            },
          }),
        },
      );
      if (!response.ok) {
        const status = response.status;
        const retry = response.headers.get("retry-after");
        await response.body?.cancel();
        if (status === 429 || status === 503) {
          const seconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry)
              : retry
                ? (Date.parse(retry) - Date.now()) / 1000
                : 60;
          const delay = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 86400)) : 60;
          throw new ExplorerError(
            "AI_RATE_LIMITED",
            "Gemini is rate limited or temporarily unavailable. Wait before retrying; the previous overview and structural map are preserved.",
            429,
            new Date(Date.now() + delay * 1000).toISOString(),
          );
        }
        if (status === 401 || status === 403)
          throw new ExplorerError(
            "AI_AUTH",
            "Gemini rejected access. Check the server API key and project permissions.",
            503,
          );
        if (status === 400 || status === 404)
          throw new ExplorerError(
            "AI_MODEL_UNAVAILABLE",
            "Gemini rejected the configured model or structured-output request. Check GEMINI_MODEL and its supported API features.",
            502,
          );
        throw new ExplorerError(
          "AI_UNAVAILABLE",
          "Gemini could not complete this request. Your saved work is preserved.",
          502,
        );
      }
      const envelope = envelopeSchema.safeParse(await boundedJson(response));
      if (!envelope.success)
        throw new ExplorerError(
          "AI_INVALID_OUTPUT",
          "Gemini returned an unsupported response structure. The previous overview is preserved.",
          502,
        );
      const result = envelope.data;
      const candidate = result.candidates?.[0];
      if (!candidate || candidate.finishReason !== "STOP")
        throw new ExplorerError(
          "AI_INCOMPLETE",
          "Gemini blocked the request or returned incomplete output. Nothing has replaced your saved overview.",
          502,
        );
      const text =
        candidate.content?.parts
          ?.filter((part) => !part.thought && typeof part.text === "string")
          .map((part) => part.text)
          .join("") ?? "";
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ExplorerError(
          "AI_INVALID_OUTPUT",
          "Gemini did not return valid structured JSON. The previous overview is preserved.",
          502,
        );
      }
      const usage: Usage = {};
      for (const [to, from] of [
        ["inputTokens", "promptTokenCount"],
        ["outputTokens", "candidatesTokenCount"],
        ["totalTokens", "totalTokenCount"],
      ] as const) {
        const value = result.usageMetadata?.[from];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
          usage[to] = value;
      }
      return {
        output,
        usage,
        ...(typeof result.modelVersion === "string" && result.modelVersion.length <= 150
          ? { modelVersion: result.modelVersion }
          : {}),
      };
    } catch (error) {
      if (input.signal?.aborted)
        throw new ExplorerError(
          "CANCELLED",
          "Overview generation stopped. The previous saved result is preserved.",
          499,
        );
      if (timeout.aborted)
        throw new ExplorerError(
          "AI_TIMEOUT",
          "Gemini did not finish within two minutes. Your saved work is preserved.",
          504,
        );
      if (error instanceof ExplorerError) throw error;
      // Never echo provider bodies, keys, request URLs or transport errors.
      throw new ExplorerError(
        "AI_UNAVAILABLE",
        "Could not reach Gemini. Check the connection and try again later.",
        502,
      );
    }
  }
}
