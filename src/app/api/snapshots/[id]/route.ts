import { z } from "zod";
import { getStore } from "@/lib/storage/snapshots";
import { ExplorerError } from "@/lib/github/errors";
import { errorResponse, requireSameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveId(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
  if (!getStore().getSnapshot(id))
    throw new ExplorerError(
      "SNAPSHOT_NOT_FOUND",
      "This snapshot is no longer available. Open the repository again.",
      404,
    );
  return id;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(
      { snapshot: getStore().getSnapshot(await resolveId(params)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    getStore().deleteSnapshot(await resolveId(params));
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
