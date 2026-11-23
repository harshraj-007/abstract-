import { ExplorerError, publicError } from "@/lib/github/errors";

export function errorResponse(error: unknown) {
  const result = publicError(error);
  return Response.json(
    { error: result.error },
    { status: result.status, headers: { "Cache-Control": "no-store" } },
  );
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next.js can construct request.url using localhost while the browser uses
  // 127.0.0.1. Compare the browser Origin to the actual HTTP Host, not that URL.
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  let matches = true;
  if (origin) {
    try {
      matches = new URL(origin).host === host && new URL(origin).protocol === requestUrl.protocol;
    } catch {
      matches = false;
    }
  }
  if (request.headers.get("sec-fetch-site") === "cross-site" || !matches) {
    throw new ExplorerError(
      "ORIGIN_DENIED",
      "This request must come from your local Abstract workspace.",
      403,
    );
  }
}

export async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ExplorerError("INVALID_REQUEST", "Send a JSON request body.", 415);
  if (!request.body) throw new ExplorerError("INVALID_REQUEST", "A repository URL is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new ExplorerError("INVALID_REQUEST", "This request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ExplorerError("INVALID_REQUEST", "Send a valid JSON request body.");
  }
}
