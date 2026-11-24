import { z } from "zod";
import { questionService } from "@/lib/ai/questions";
import { questionDraftSchema } from "@/lib/contracts/questions";
import { GitHubClient } from "@/lib/github/client";
import { ExplorerError } from "@/lib/github/errors";
import { errorResponse, readSmallJson, requireSameOrigin } from "@/lib/http";
import { getStore } from "@/lib/storage/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), draft: questionDraftSchema }).strict(),
  z.object({ action: z.literal("read"), draft: questionDraftSchema }).strict(),
  z
    .object({
      action: z.literal("answer"),
      draft: questionDraftSchema,
      allowSourceSharing: z.literal(true),
      evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
async function idFrom(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    throw new ExplorerError("SNAPSHOT_NOT_FOUND", "Snapshot not found.", 404);
  return id;
}
function json(data: unknown) {
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = await idFrom(params);
    const answer = new URL(request.url).searchParams.get("answer");
    if (answer !== null && !z.uuid().safeParse(answer).success)
      throw new ExplorerError("ANSWER_NOT_FOUND", "Saved answer not found.", 404);
    return answer
      ? json(await questionService.saved(id, getStore(), answer))
      : json({ answers: questionService.history(id, getStore()) });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const id = await idFrom(params);
    const body = requestSchema.safeParse(await readSmallJson(request, 8192));
    if (!body.success)
      throw new ExplorerError(
        "INVALID_REQUEST",
        "Choose a source file, a question of up to 1,000 characters, and an explanation depth. Preview context before explicitly sending it to Gemini.",
      );
    const { draft } = body.data;
    const store = getStore();
    if (body.data.action === "read")
      return json(
        await questionService.readContext(
          id,
          store,
          draft,
          new GitHubClient({
            token: process.env.GITHUB_TOKEN || undefined,
            signal: request.signal,
          }),
          request.signal,
        ),
      );
    if (body.data.action === "preview")
      return json(await questionService.preview(id, store, draft));
    return json(
      await questionService.answer(id, store, draft, {
        evidenceFingerprint: body.data.evidenceFingerprint,
        signal: request.signal,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
