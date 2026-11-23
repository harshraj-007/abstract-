import { z } from "zod";
import { getStore } from "@/lib/storage/snapshots";
import { GitHubClient } from "@/lib/github/client";
import { loadSource } from "@/lib/github/ingest";
import { ExplorerError } from "@/lib/github/errors";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
    const store = getStore();
    const fileId = new URL(request.url).searchParams.get("file");
    if (fileId === null) {
      const snapshot = store.getSnapshot(id);
      if (!snapshot) throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
      return Response.json({ files: snapshot.files }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!/^[a-f0-9]{24}$/.test(fileId))
      throw new ExplorerError(
        "FILE_NOT_FOUND",
        "Select a file from this snapshot's file tree.",
        404,
      );
    const result = await loadSource(
      id,
      fileId,
      new GitHubClient({ token: process.env.GITHUB_TOKEN || undefined, signal: request.signal }),
      store,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
