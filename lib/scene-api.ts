import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { requireAuthorizedUser, type AuthUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { cleanupSceneImages, sceneClient, SceneTierError } from "@/lib/scene-store";
import { SceneError, type VivianScene } from "@/lib/scenes";
import { StorageError } from "@/lib/cloud-storage";
import { ensureUserAccount, TierError, tierErrorResponse, type UserTier } from "@/lib/user-tiers";

export const SCENE_IMAGE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
let devSceneSecret: string | null = null;

function getSceneImageTokenSecret(): string | null {
  const configured =
    process.env.SCENE_IMAGE_TOKEN_SECRET?.trim() ||
    process.env.VIVIAN_INTERNAL_TOKEN?.trim() ||
    process.env.TIER_ACTION_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (configured) return configured;
  if (process.env.NODE_ENV === "development" && process.env.DEV_BYPASS_LOGIN === "true") {
    devSceneSecret ??= randomBytes(32).toString("hex");
    return devSceneSecret;
  }
  return null;
}

export interface SceneImageTokenPayload {
  sceneId: string;
  userId: string;
  exp: number;
}

export function createSceneImageToken(
  sceneId: string,
  userId: string,
  options: { now?: number; ttlMs?: number; secret?: string } = {},
): string | null {
  const secret = options.secret?.trim() || getSceneImageTokenSecret();
  if (!secret || !sceneId.trim() || !userId.trim()) return null;
  const payload: SceneImageTokenPayload = {
    sceneId,
    userId,
    exp: (options.now ?? Date.now()) + (options.ttlMs ?? SCENE_IMAGE_TOKEN_TTL_MS),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigB64 = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sigB64}`;
}

export function verifySceneImageToken(
  token: string,
  expectedSceneId: string,
  options: { now?: number; secret?: string } = {},
): SceneImageTokenPayload | null {
  if (typeof token !== "string" || typeof expectedSceneId !== "string" || !expectedSceneId.trim()) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const secret = options.secret?.trim() || getSceneImageTokenSecret();
  if (!secret) return null;

  const expectedSigB64 = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const actualBuf = Buffer.from(sigB64, "utf8");
  const expectedBuf = Buffer.from(expectedSigB64, "utf8");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      !parsed ||
      parsed.sceneId !== expectedSceneId ||
      typeof parsed.userId !== "string" ||
      !parsed.userId.trim() ||
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp)
    ) {
      return null;
    }
    if ((options.now ?? Date.now()) > parsed.exp) return null;
    return {
      sceneId: parsed.sceneId,
      userId: parsed.userId,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function appendSceneToken(rawUrl: string, token: string): string {
  const parsed = new URL(rawUrl, "https://vivian.local");
  parsed.searchParams.set("token", token);
  return `${parsed.pathname}${parsed.search}`;
}

export function signSceneUrls(
  scene: VivianScene,
  userId: string,
  options: { now?: number; ttlMs?: number; secret?: string } = {},
): VivianScene {
  const token = createSceneImageToken(scene.id, userId, options);
  if (!token) return scene;
  return {
    ...scene,
    imageUrl: appendSceneToken(scene.imageUrl, token),
    thumbnailUrl: appendSceneToken(scene.thumbnailUrl, token),
  };
}

export function sceneErrorResponse(error: unknown): Response {
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
    return sceneErrorResponse(error);
  }
}
