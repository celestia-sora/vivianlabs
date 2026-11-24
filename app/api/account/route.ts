import { NextResponse } from "next/server";
import { isSorachanEmail, SELECTED_REQUEST_EMAIL } from "@/lib/auth/policy";
import { requireAuthorizedUser } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildSelectedRequestMailto, listUserTierRequests, TierRequestError } from "@/lib/tier-requests";
import { defaultUserProfile } from "@/lib/user-profile";
import { loadUserProfileServer } from "@/lib/user-profile-store";
import { getUserTierSummary, TierError, tierErrorResponse } from "@/lib/user-tiers";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const rate = rateLimit(request, `account:${user.id}`, 60);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    const summary = await getUserTierSummary(db, user);
    const isSorachan = isSorachanEmail(summary.email);
    const [requests, userProfile] = await Promise.all([
      listUserTierRequests(db, summary.userId),
      loadUserProfileServer(db, summary.userId, isSorachan).catch(() =>
        defaultUserProfile(summary.userId, isSorachan),
      ),
    ]);
    const selectedRequest = requests.find((item) => item.status === "pending") ?? requests[0] ?? null;
    const mailtoUrl = buildSelectedRequestMailto({
      userEmail: summary.email,
      userId: summary.userId,
      displayName: selectedRequest?.displayName,
      reason: selectedRequest?.reason,
      requestId: selectedRequest?.id,
    });

    return NextResponse.json(
      {
        user: { id: summary.userId, email: summary.email },
        tier: summary.tier,
        isSorachan,
        userProfile,
        capabilities: summary.capabilities,
        chatQuota: summary.chatQuota,
        storage: summary.storage,
        selectedRequest,
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
      { error: "Account service is temporarily unavailable.", status: 503, code: "TIER_UNAVAILABLE" },
      { status: 503, headers },
    );
  }
}
