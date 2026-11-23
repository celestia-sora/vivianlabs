import { NextResponse } from "next/server";
import { isSorachanEmail, normalizeEmail } from "@/lib/auth/policy";
import { requireAuthorizedUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  listAllTierRequests,
  reviewTierRequest,
  TierRequestError,
  type TierRequestStatus,
} from "@/lib/tier-requests";
import {
  requireAdmin,
  resolveEffectiveTier,
  setUserTier,
  TierError,
  tierErrorResponse,
} from "@/lib/user-tiers";

const headers = { "Cache-Control": "private, no-store" };

function handleAdminError(error: unknown): Response {
  if (error instanceof TierError) return tierErrorResponse(error);
  if (error instanceof TierRequestError) {
    return NextResponse.json(
      { error: error.message, status: error.status, code: error.code },
      { status: error.status, headers },
    );
  }
  return NextResponse.json(
    { error: "Admin tier service is temporarily unavailable.", status: 503, code: "TIER_UNAVAILABLE" },
    { status: 503, headers },
  );
}

export async function GET(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const rate = rateLimit(request, `admin-tier-requests:${user.id}`, 60);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  const rawStatus = new URL(request.url).searchParams.get("status");
  if (rawStatus !== null && rawStatus !== "pending" && rawStatus !== "approved" && rawStatus !== "rejected") {
    return NextResponse.json(
      { error: "Invalid status filter.", status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    const requests = await listAllTierRequests(db, user, rawStatus ? { status: rawStatus as TierRequestStatus } : {});
    const { data: accountRows, error: accountError } = await db
      .from("vivian_user_accounts")
      .select("user_id,email,tier,updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (accountError) {
      throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
    }

    const accounts = (accountRows ?? [])
      .filter((row) => !isSorachanEmail((row as { email?: string | null }).email))
      .map((row) => {
        const record = row as { user_id: string; email: string; tier: string; updated_at: string };
        return {
          userId: record.user_id,
          email: record.email,
          tier: resolveEffectiveTier(record.email, record.tier),
          updatedAt: record.updated_at,
        };
      });

    return NextResponse.json({ requests, accounts }, { headers });
  } catch (error) {
    return handleAdminError(error);
  }
}

export async function POST(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const rate = rateLimit(request, `admin-tier-requests-post:${user.id}`, 30);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    await requireAdmin(db, user);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body.", status: 400, code: "INVALID_REQUEST" },
        { status: 400, headers },
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Invalid admin action payload.", status: 400, code: "INVALID_REQUEST" },
        { status: 400, headers },
      );
    }

    const payload = body as Record<string, unknown>;
    if (payload.action === "approve" || payload.action === "reject") {
      if (typeof payload.requestId !== "string" || !payload.requestId.trim()) {
        return NextResponse.json(
          { error: "requestId is required.", status: 400, code: "INVALID_REQUEST" },
          { status: 400, headers },
        );
      }
      if (payload.reviewNote !== undefined && payload.reviewNote !== null && typeof payload.reviewNote !== "string") {
        return NextResponse.json(
          { error: "reviewNote must be a string.", status: 400, code: "INVALID_REQUEST" },
          { status: 400, headers },
        );
      }
      const result = await reviewTierRequest(db, user, {
        requestId: payload.requestId.trim(),
        action: payload.action,
        reviewNote: typeof payload.reviewNote === "string" ? payload.reviewNote : undefined,
      });
      return NextResponse.json(
        {
          ok: true,
          action: payload.action,
          alreadyReviewed: result.alreadyReviewed,
          request: result.request,
        },
        { headers },
      );
    }

    if (payload.action === "set_tier") {
      const identifier = typeof payload.emailOrUserId === "string" ? payload.emailOrUserId.trim() : "";
      if (!identifier) {
        return NextResponse.json(
          { error: "emailOrUserId is required.", status: 400, code: "INVALID_REQUEST" },
          { status: 400, headers },
        );
      }
      if (payload.tier !== "free" && payload.tier !== "selected") {
        return NextResponse.json(
          { error: "tier must be 'free' or 'selected'.", status: 400, code: "INVALID_REQUEST" },
          { status: 400, headers },
        );
      }
      if (isSorachanEmail(identifier)) {
        throw new TierError("Cannot modify a Sorachan admin account tier.", 400, "ADMIN_REQUIRED");
      }

      let targetUserId = identifier;
      if (identifier.includes("@")) {
        const normalizedEmail = normalizeEmail(identifier);
        const lookup = await db
          .from("vivian_user_accounts")
          .select("user_id,email")
          .eq("email", normalizedEmail)
          .maybeSingle();
        if (lookup.error) {
          throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
        }
        if (!lookup.data) {
          throw new TierError("User account not found.", 404, "TIER_UNAVAILABLE");
        }
        const target = lookup.data as { user_id: string; email: string };
        if (isSorachanEmail(target.email)) {
          throw new TierError("Cannot modify a Sorachan admin account tier.", 400, "ADMIN_REQUIRED");
        }
        targetUserId = target.user_id;
      }

      const account = await setUserTier(db, targetUserId, payload.tier);
      return NextResponse.json(
        {
          ok: true,
          action: "set_tier",
          account,
        },
        { headers },
      );
    }

    return NextResponse.json(
      { error: "Invalid admin action.", status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  } catch (error) {
    return handleAdminError(error);
  }
}
