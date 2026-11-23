import { requireAuthorizedUser } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { HistoryError, deleteHistory, listHistory, readHistory, saveHistory, validateHistoryWrite } from "@/lib/chat-history-store";
import { SceneError } from "@/lib/scenes";
import { readBoundedSceneBody } from "@/lib/scene-images";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";

async function historyApi(request: Request, action: (userId: string) => Promise<Response>): Promise<Response> {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;
  const quota = rateLimit(request, `history:${user.id}`, 180);
  if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);
  try {
    const response = await action(user.id);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const status = error instanceof HistoryError || error instanceof SceneError ? error.status : error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: error instanceof HistoryError || error instanceof SceneError ? error.message : status === 400 ? "Invalid conversation data." : "Chat history is temporarily unavailable.", status }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
export async function GET(request: Request): Promise<Response> {
  return historyApi(request, async (userId) => {
    const params = new URL(request.url).searchParams;
    const after = params.get("after") ?? "0", offset = params.get("offset") ?? "0";
    if (!/^\d{1,15}$/.test(after) || !/^\d{1,6}$/.test(offset)) throw new HistoryError("Invalid history cursor.");
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    return Response.json(params.has("id") ? await readHistory(db, params.get("id")!, after, userId) : await listHistory(db, Number(offset), userId));
  });
}
export async function DELETE(request: Request): Promise<Response> {
  return historyApi(request, async (userId) => {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    await deleteHistory(getSupabaseAdmin(AbortSignal.timeout(8000)), id, userId);
    return Response.json({ ok: true });
  });
}
export async function PUT(request: Request): Promise<Response> {
  return historyApi(request, async (userId) => {
    const bytes = await readBoundedSceneBody(request, 2 * 1024 * 1024);
    await saveHistory(getSupabaseAdmin(AbortSignal.timeout(8000)), validateHistoryWrite(JSON.parse(bytes.toString("utf8"))), userId);
    return Response.json({ ok: true });
  });
}
