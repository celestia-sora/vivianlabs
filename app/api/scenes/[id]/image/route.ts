import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { sceneApi, sceneErrorResponse, verifySceneImageToken } from "@/lib/scene-api";
import { getSceneImage, sceneClient } from "@/lib/scene-store";
import { resolveEffectiveTier, TierError } from "@/lib/user-tiers";

export const runtime = "nodejs";

function imageResponse(image: Blob, cacheControl: string): Response {
  return new Response(image, {
    headers: {
      "Content-Type": image.type,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      Vary: "Authorization",
    },
  });
}

// Scene images are strictly private per owner and tier-gated (Selected+).
// Browsers loading <img> / CSS backgroundImage cannot send Bearer headers, so
// /api/scenes appends a short-lived HMAC token bound to (sceneId, userId, exp).
// Every request still rechecks account tier and scene ownership in Supabase.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const thumbnail = url.searchParams.get("thumbnail") === "1";

  if (request.headers.has("authorization")) {
    return sceneApi(request, async (db, userId, tier) => {
      const image = await getSceneImage(db, userId, id, thumbnail, { tier });
      return imageResponse(image, "private, max-age=0, must-revalidate");
    });
  }

  const token = url.searchParams.get("token")?.trim() ?? "";
  if (token) {
    const verified = verifySceneImageToken(token, id);
    if (!verified) {
      return Response.json(
        { error: "Please sign in", status: 401, code: "AUTH_REQUIRED" },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const quota = rateLimit(request, `scene-image:${verified.userId}`, 120);
    if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);

    try {
      const db = sceneClient();
      const { data: accountRow, error: accountError } = await db
        .from("vivian_user_accounts")
        .select("email,tier")
        .eq("user_id", verified.userId)
        .maybeSingle();
      if (accountError) {
        throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
      }
      const row = accountRow as { email?: string | null; tier?: string | null } | null;
      const tier = resolveEffectiveTier(row?.email, row?.tier);
      const image = await getSceneImage(db, verified.userId, id, thumbnail, { tier });
      return imageResponse(image, "private, max-age=300, must-revalidate");
    } catch (error) {
      return sceneErrorResponse(error);
    }
  }

  if (process.env.NODE_ENV === "development" && process.env.DEV_BYPASS_LOGIN === "true") {
    return sceneApi(request, async (db, userId, tier) => {
      const image = await getSceneImage(db, userId, id, thumbnail, { tier });
      return imageResponse(image, "private, max-age=0, must-revalidate");
    });
  }

  return Response.json(
    { error: "Please sign in", status: 401, code: "AUTH_REQUIRED" },
    { status: 401, headers: { "Cache-Control": "private, no-store" } },
  );
}
