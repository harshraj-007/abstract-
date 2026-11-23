import { z } from "zod";
import { GitHubClient } from "@/lib/github/client";
import { ingestRepository } from "@/lib/github/ingest";
import { ExplorerError, publicError } from "@/lib/github/errors";
import { parseRepositoryUrl } from "@/lib/github/url";
import { getStore } from "@/lib/storage/snapshots";
import { errorResponse, readSmallJson, requireSameOrigin } from "@/lib/http";
import type { ImportEvent } from "@/lib/contracts/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let importsInFlight = 0;

export async function GET() {
  try {
    return Response.json(
      { snapshots: getStore().recent() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = z
      .object({ url: z.string().min(1).max(500) })
      .safeParse(await readSmallJson(request));
    if (!body.success)
      throw new ExplorerError("INVALID_URL", "Enter a public GitHub repository URL.");
    parseRepositoryUrl(body.data.url);
    if (importsInFlight >= 2)
      throw new ExplorerError(
        "BUSY",
        "Two repositories are already opening. Wait for one to finish, then try again.",
        429,
      );
    const store = getStore();
    const client = new GitHubClient({
      token: process.env.GITHUB_TOKEN || undefined,
      signal: request.signal,
    });
    importsInFlight++;
    const encoder = new TextEncoder();
    let disconnected = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(event: ImportEvent) {
          if (!disconnected) {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            } catch {
              disconnected = true;
            }
          }
        }
        try {
          const snapshot = await ingestRepository(body.data.url, client, store, send);
          send({ type: "complete", snapshot });
        } catch (error) {
          send({ type: "error", error: publicError(error).error });
        } finally {
          importsInFlight--;
          if (!disconnected) {
            try {
              controller.close();
            } catch {
              /* Client closed the connection. */
            }
          }
        }
      },
      cancel() {
        disconnected = true;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
