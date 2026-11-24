import { z } from "zod";
import { getStore } from "@/lib/storage/snapshots";
import { GitHubClient } from "@/lib/github/client";
import { ExplorerError, publicError } from "@/lib/github/errors";
import { buildStructuralAnalysis, getAnalysisResult } from "@/lib/analysis/service";
import { errorResponse, readSmallJson, requireSameOrigin } from "@/lib/http";
import type { AnalysisEvent } from "@/lib/contracts/analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const active = new Set<string>();

async function idFrom(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
  return id;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(getAnalysisResult(await idFrom(params), getStore()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const id = await idFrom(params);
    const body = z
      .object({ fetchMissing: z.boolean() })
      .strict()
      .safeParse(await readSmallJson(request));
    if (!body.success)
      throw new ExplorerError(
        "INVALID_REQUEST",
        "Choose whether to read more source files before building the map.",
      );
    const store = getStore();
    getAnalysisResult(id, store);
    if (active.has(id) || active.size >= 2)
      throw new ExplorerError(
        "BUSY",
        "A map is already being built, or two snapshots are busy. Wait for a task to finish.",
        429,
      );
    active.add(id);
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal]);
    const client = new GitHubClient({ token: process.env.GITHUB_TOKEN || undefined, signal });
    const encoder = new TextEncoder();
    let disconnected = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(event: AnalysisEvent) {
          if (!disconnected) {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            } catch {
              disconnected = true;
              abort.abort();
            }
          }
        }
        try {
          const result = await buildStructuralAnalysis(
            id,
            store,
            client,
            { fetchMissing: body.data.fetchMissing, signal },
            send,
          );
          send({
            type: "complete",
            analysis: result.analysis,
            snapshot: result.snapshot,
            stale: result.stale,
          });
        } catch (error) {
          send({ type: "error", error: publicError(error).error });
        } finally {
          active.delete(id);
          if (!disconnected) {
            try {
              controller.close();
            } catch {
              /* The request was closed. */
            }
          }
        }
      },
      cancel() {
        disconnected = true;
        abort.abort();
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
