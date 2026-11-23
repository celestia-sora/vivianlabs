import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { requireAuthorizedUser, type AuthUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { cleanupSceneImages, sceneClient, SceneTierError } from "@/lib/scene-store";
import { SceneError } from "@/lib/scenes";
import { StorageError } from "@/lib/cloud-storage";
import { ensureUserAccount, TierError, tierErrorResponse, type UserTier } from "@/lib/user-tiers";

export async function sceneApi(
  request: Request,
  action: (db: SupabaseClient, userId: string, tier: UserTier, user: AuthUser) => Promise<Response>,
): Promise<Response> {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;
  const owner = user.id;
  if (request.method !== "GET") {
    const quota = rateLimit(request, `scenes:${owner}`, 20);
    if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);
  }
  try {
    const db = sceneClient();
    const account = await ensureUserAccount(db, user);
    const response = await action(db, owner, account.tier, user);
    if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "private, no-store");
    if (account.tier !== "free" && (request.method !== "GET" || new URL(request.url).pathname === "/api/scenes")) {
      after(() => cleanupSceneImages(owner));
    }
    return response;
  } catch (error) {
    if (error instanceof TierError) return tierErrorResponse(error);
    if (error instanceof SceneTierError) {
      return Response.json(
        {
          error: error.message,
          status: error.status,
          code: error.code,
          requiredTier: error.requiredTier,
        },
        { status: error.status, headers: { "Cache-Control": "private, no-store" } },
      );
    }
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
    const status = error instanceof SceneError ? error.status : error instanceof SyntaxError || error instanceof TypeError ? 400 : 503;
    return Response.json(
      {
        error: error instanceof SceneError
          ? error.message
          : status === 400
            ? "Invalid scene data or image import failed. Check the URL/file and try again."
            : "Scene storage is temporarily unavailable. Please try again.",
        status,
      },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
