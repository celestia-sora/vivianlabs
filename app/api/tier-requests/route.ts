import { NextResponse } from "next/server";
import { SELECTED_REQUEST_EMAIL } from "@/lib/auth/policy";
import { requireAuthorizedUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  MAX_REQUEST_DISPLAY_NAME_LENGTH,
  MAX_REQUEST_REASON_LENGTH,
  TierRequestError,
  buildSelectedRequestMailto,
  createSelectedTierRequest,
  listUserTierRequests,
} from "@/lib/tier-requests";
import { ensureUserAccount, TierError, tierErrorResponse } from "@/lib/user-tiers";

const headers = { "Cache-Control": "private, no-store" };

function requestBaseUrl(request: Request): string | undefined {
  if (
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    process.env.VERCEL_URL?.trim()
  ) {
    return undefined;
  }
  try {
    const target = new URL(request.url);
    const host = request.headers.get("host");
    if (host) target.host = host;
    if (target.protocol === "https:" || target.protocol === "http:") return target.origin;
  } catch {
    // Ignore malformed URLs
  }
  return undefined;
}

export async function GET(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const rate = rateLimit(request, `tier-requests:${user.id}`, 30);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    const account = await ensureUserAccount(db, user);
    const requests = await listUserTierRequests(db, account.userId);
    const latest = requests.find((item) => item.status === "pending") ?? requests[0] ?? null;
    const mailtoUrl = buildSelectedRequestMailto({
      userEmail: account.email,
      userId: account.userId,
      displayName: latest?.displayName,
      reason: latest?.reason,
      requestId: latest?.id,
    });

    return NextResponse.json(
      {
        requests,
        mailtoUrl,
        requestEmail: SELECTED_REQUEST_EMAIL,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof TierError) return tierErrorResponse(error);
    if (error instanceof TierRequestError) {
      return NextResponse.json(
        { error: error.message, status: error.status, code: error.code },
        { status: error.status, headers },
      );
    }
    return NextResponse.json(
      { error: "Tier request service is temporarily unavailable.", status: 503, code: "REQUEST_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}

export async function POST(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const rate = rateLimit(request, `tier-requests-post:${user.id}`, 10);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  let parsedBody: Record<string, unknown> = {};
  try {
    const rawText = await request.text();
    if (rawText.trim()) {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return NextResponse.json(
          { error: "Invalid tier request payload.", status: 400, code: "INVALID_REQUEST" },
          { status: 400, headers },
        );
      }
      parsedBody = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body.", status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }

  const rawDisplayName = parsedBody.displayName;
  const rawReason = parsedBody.reason;
  if (rawDisplayName !== undefined && rawDisplayName !== null && typeof rawDisplayName !== "string") {
    return NextResponse.json(
      { error: "displayName must be a string.", status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return NextResponse.json(
      { error: "reason must be a string.", status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }
  if (typeof rawDisplayName === "string" && rawDisplayName.trim().length > MAX_REQUEST_DISPLAY_NAME_LENGTH) {
    return NextResponse.json(
      { error: `displayName must be at most ${MAX_REQUEST_DISPLAY_NAME_LENGTH} characters.`, status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }
  if (typeof rawReason === "string" && rawReason.trim().length > MAX_REQUEST_REASON_LENGTH) {
    return NextResponse.json(
      { error: `reason must be at most ${MAX_REQUEST_REASON_LENGTH} characters.`, status: 400, code: "INVALID_REQUEST" },
      { status: 400, headers },
    );
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    const baseUrl = requestBaseUrl(request);
    const result = await createSelectedTierRequest(
      db,
      user,
      {
        displayName: typeof rawDisplayName === "string" ? rawDisplayName : undefined,
        reason: typeof rawReason === "string" ? rawReason : undefined,
      },
      baseUrl ? { baseUrl } : {},
    );

    // Never expose signed approveUrl / rejectUrl to the requester.
    return NextResponse.json(
      {
        request: result.request,
        alreadyPending: result.alreadyPending,
        emailSent: result.emailSent,
        mailtoUrl: result.mailtoUrl,
        requestEmail: SELECTED_REQUEST_EMAIL,
      },
      { status: result.alreadyPending ? 200 : 201, headers },
    );
  } catch (error) {
    if (error instanceof TierError) return tierErrorResponse(error);
    if (error instanceof TierRequestError) {
      return NextResponse.json(
        { error: error.message, status: error.status, code: error.code },
        { status: error.status, headers },
      );
    }
    return NextResponse.json(
      { error: "Tier request service is temporarily unavailable.", status: 503, code: "REQUEST_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
