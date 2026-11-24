import { z } from "zod";
import { overviewService } from "@/lib/ai/service";
import { getStore } from "@/lib/storage/snapshots";
import { ExplorerError } from "@/lib/github/errors";
import { errorResponse, readSmallJson, requireSameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshotId(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
  return id;
}
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(await overviewService.getState(await snapshotId(params), getStore()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const id = await snapshotId(params);
    const body = z
      .object({
        allowSourceSharing: z.literal(true),
        evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(await readSmallJson(request));
    if (!body.success)
      throw new ExplorerError(
        "INVALID_REQUEST",
        "Review the evidence, then explicitly choose to share these excerpts with Gemini.",
        400,
      );
    const state = await overviewService.generate(id, getStore(), {
      evidenceFingerprint: body.data.evidenceFingerprint,
      signal: request.signal,
    });
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
