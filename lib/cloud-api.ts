import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { requireAuthorizedUser, type AuthUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { sceneClient } from "@/lib/scene-store";
import { StorageError } from "@/lib/cloud-storage";
import { cleanupCloudModels } from "@/lib/cloud-store";
import { publishModelLibraryChange } from "@/lib/model-library-broadcast";
import { ensureUserAccount, TierError, tierErrorResponse, type UserTier } from "@/lib/user-tiers";

export async function cloudApi(
  request: Request,
  action: (db: SupabaseClient, userId: string, tier: UserTier, user: AuthUser) => Promise<Response>,
): Promise<Response> {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;
  const owner = user.id;
  const scope = new URL(request.url).pathname.startsWith("/api/storage/") ? "storage-status" : "models";
  const limit = rateLimit(request, `${scope}:${owner}`, 60);
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfter);
  try {
    const db = sceneClient(AbortSignal.timeout(30_000));
    const account = await ensureUserAccount(db, user);
    const response = await action(db, owner, account.tier, user);
    response.headers.set("Cache-Control", "private, no-store");
    const pathname = new URL(request.url).pathname;
    const modelMutation = pathname === "/api/models/preference" && request.method === "PATCH"
      || /^\/api\/models\/[^/]+\/expressions$/.test(pathname) && request.method === "PATCH"
      || /^\/api\/models\/[^/]+$/.test(pathname) && ["POST", "DELETE"].includes(request.method);
    if (response.ok && modelMutation) {
      after(() => publishModelLibraryChange());
    }
    if (account.tier !== "free" && request.method === "GET" && pathname === "/api/models") {
      after(() => cleanupCloudModels(sceneClient(AbortSignal.timeout(30_000)), owner).catch(() => {}));
    }
    return response;
  } catch (error) {
    if (error instanceof TierError) return tierErrorResponse(error);
    if (error instanceof StorageError) {
      return Response.json(
        {
          error: error.message,
          status: error.status,
          ...(error.code ? { code: error.code } : {}),
          ...(error.code === "TIER_REQUIRED" ? { requiredTier: "selected" } : {}),
        },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const status = error instanceof SyntaxError ? 400 : 503;
    return Response.json(
      { error: status === 400 ? "Invalid model data." : "Cloud storage is temporarily unavailable.", status },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
