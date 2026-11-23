import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/lib/auth/policy";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  TierRequestError,
  reviewTierRequestByToken,
  verifyTierActionToken,
  type TierRequestRecord,
  type TierReviewAction,
} from "@/lib/tier-requests";

const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const jsonHeaders = {
  "Cache-Control": "no-store",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtmlPage(params: {
  title: string;
  heading: string;
  bodyHtml: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #2c1e42 0%, #140f1e 65%);
      color: #f4effa;
    }
    main {
      width: 100%;
      max-width: 480px;
      padding: 28px;
      border-radius: 16px;
      background: rgba(29, 21, 44, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
    }
    h1 { margin: 0 0 12px; font-size: 1.35rem; }
    p { margin: 0 0 16px; color: #d6c8eb; line-height: 1.55; }
    dl { margin: 0 0 20px; display: grid; gap: 8px; font-size: 0.94rem; }
    .row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
    dt { color: #a794c5; font-weight: 600; }
    dd { margin: 0; text-align: right; word-break: break-word; }
    button {
      width: 100%;
      border: 0;
      border-radius: 10px;
      padding: 12px 18px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: #6b46c1;
    }
    button.reject { background: #9b2c2c; }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      background: rgba(139, 92, 246, 0.22);
      color: #e9d8fd;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.heading)}</h1>
    ${params.bodyHtml}
  </main>
</body>
</html>`;
}

function renderRequestDetails(req: Pick<TierRequestRecord, "id" | "email" | "displayName" | "reason" | "status">): string {
  return `<dl>
    <div class="row"><dt>Email</dt><dd>${escapeHtml(req.email)}</dd></div>
    ${req.displayName ? `<div class="row"><dt>Name</dt><dd>${escapeHtml(req.displayName)}</dd></div>` : ""}
    <div class="row"><dt>Status</dt><dd><span class="badge">${escapeHtml(req.status)}</span></dd></div>
    <div class="row"><dt>Request ID</dt><dd><code>${escapeHtml(req.id)}</code></dd></div>
    ${req.reason ? `<div class="row"><dt>Reason</dt><dd>${escapeHtml(req.reason)}</dd></div>` : ""}
  </dl>`;
}

function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

async function parseTokenFromRequest(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const parsed = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    return typeof parsed?.token === "string" ? parsed.token.trim() : "";
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return new URLSearchParams(text).get("token")?.trim() ?? "";
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const raw = form.get("token");
    return typeof raw === "string" ? raw.trim() : "";
  }
  const rawText = await request.text().catch(() => "");
  if (!rawText.trim()) return "";
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown> | null;
    if (parsed && typeof parsed.token === "string") return parsed.token.trim();
  } catch {
    const fromParams = new URLSearchParams(rawText).get("token");
    if (fromParams) return fromParams.trim();
  }
  return "";
}

export async function GET(request: Request) {
  const rate = rateLimit(request, "tier-review-get", 60);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const verified = verifyTierActionToken(token);
  const asJson = wantsJson(request);

  if (!verified) {
    if (asJson) {
      return NextResponse.json(
        { error: "This review link is invalid or has expired.", status: 400, code: "INVALID_TOKEN" },
        { status: 400, headers: jsonHeaders },
      );
    }
    return new Response(
      renderHtmlPage({
        title: "Vivian Tier Review",
        heading: "Invalid or expired review link",
        bodyHtml: "<p>This Selected tier review link is invalid or has expired. Please review pending requests from Settings in Vivian.</p>",
      }),
      { status: 400, headers: htmlHeaders },
    );
  }

  let requestInfo: TierRequestRecord | null = null;
  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const { data, error } = await db
      .from("vivian_tier_requests")
      .select("id,user_id,email,display_name,reason,status,reviewed_by,review_note,reviewed_at,created_at,updated_at")
      .eq("id", verified.requestId)
      .maybeSingle();

    if (!error) {
      if (!data) {
        if (asJson) {
          return NextResponse.json(
            { error: "Tier request not found.", status: 404, code: "REQUEST_NOT_FOUND" },
            { status: 404, headers: jsonHeaders },
          );
        }
        return new Response(
          renderHtmlPage({
            title: "Vivian Tier Review",
            heading: "Tier request not found",
            bodyHtml: "<p>This Selected tier request could not be found.</p>",
          }),
          { status: 404, headers: htmlHeaders },
        );
      }
      const row = data as {
        id: string;
        user_id: string;
        email: string;
        display_name: string;
        reason: string;
        status: TierRequestRecord["status"];
        reviewed_by: string | null;
        review_note: string;
        reviewed_at: string | null;
        created_at: string;
        updated_at: string;
      };
      requestInfo = {
        id: row.id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name ?? "",
        reason: row.reason ?? "",
        status: row.status,
        reviewedBy: row.reviewed_by ?? null,
        reviewNote: row.review_note ?? "",
        reviewedAt: row.reviewed_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
  } catch {
    // Allow rendering the confirmation form even if preview read fails transiently.
  }

  if (asJson) {
    return NextResponse.json(
      {
        valid: true,
        action: verified.action,
        requestId: verified.requestId,
        request: requestInfo,
      },
      { status: 200, headers: jsonHeaders },
    );
  }

  const actionLabel = verified.action === "approve" ? "Approve Selected Tier" : "Reject Selected Tier";
  const alreadyReviewedHtml = requestInfo && requestInfo.status !== "pending"
    ? `<p>This request has already been marked <strong>${escapeHtml(requestInfo.status)}</strong>.</p>${renderRequestDetails(requestInfo)}`
    : `<p>Confirm to <strong>${escapeHtml(verified.action)}</strong> this Selected tier request. No changes are made until you press the button below.</p>
       ${requestInfo ? renderRequestDetails(requestInfo) : `<dl><div class="row"><dt>Request ID</dt><dd><code>${escapeHtml(verified.requestId)}</code></dd></div></dl>`}
       <form method="POST" action="/api/tier-requests/review">
         <input type="hidden" name="token" value="${escapeHtml(token)}" />
         <button type="submit" class="${verified.action === "reject" ? "reject" : ""}">${escapeHtml(actionLabel)}</button>
       </form>`;

  return new Response(
    renderHtmlPage({
      title: actionLabel,
      heading: actionLabel,
      bodyHtml: alreadyReviewedHtml,
    }),
    { status: 200, headers: htmlHeaders },
  );
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Cross-site request rejected", status: 403, code: "ACCESS_DENIED" },
      { status: 403, headers: jsonHeaders },
    );
  }

  const rate = rateLimit(request, "tier-review-post", 30);
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfter);

  const asJson = wantsJson(request);
  const token = await parseTokenFromRequest(request);
  if (!token) {
    if (asJson) {
      return NextResponse.json(
        { error: "This review link is invalid or has expired.", status: 400, code: "INVALID_TOKEN" },
        { status: 400, headers: jsonHeaders },
      );
    }
    return new Response(
      renderHtmlPage({
        title: "Vivian Tier Review",
        heading: "Invalid review token",
        bodyHtml: "<p>Missing or invalid tier review token.</p>",
      }),
      { status: 400, headers: htmlHeaders },
    );
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(10_000));
    const result = await reviewTierRequestByToken(db, token);

    if (asJson) {
      return NextResponse.json(
        {
          ok: true,
          action: result.action,
          alreadyReviewed: result.alreadyReviewed,
          request: result.request,
        },
        { status: 200, headers: jsonHeaders },
      );
    }

    const headingByAction: Record<TierReviewAction, string> = {
      approve: result.alreadyReviewed ? "Request already approved" : "Selected tier approved",
      reject: result.alreadyReviewed ? "Request already rejected" : "Selected tier request rejected",
    };

    const noteText = result.alreadyReviewed
      ? `This request was previously marked ${result.request.status}.`
      : result.action === "approve"
        ? "This account now has Selected tier access (20 chats/day, 512 MiB private R2 storage)."
        : "This Selected tier request has been rejected.";

    return new Response(
      renderHtmlPage({
        title: headingByAction[result.action],
        heading: headingByAction[result.action],
        bodyHtml: `<p>${escapeHtml(noteText)}</p>${renderRequestDetails(result.request)}`,
      }),
      { status: 200, headers: htmlHeaders },
    );
  } catch (error) {
    const status = error instanceof TierRequestError ? error.status : 503;
    const code = error instanceof TierRequestError ? error.code : "REQUEST_UNAVAILABLE";
    const message = error instanceof TierRequestError ? error.message : "Tier request service is temporarily unavailable.";

    if (asJson) {
      return NextResponse.json({ error: message, status, code }, { status, headers: jsonHeaders });
    }
    return new Response(
      renderHtmlPage({
        title: "Vivian Tier Review",
        heading: "Could not complete review",
        bodyHtml: `<p>${escapeHtml(message)}</p>`,
      }),
      { status, headers: htmlHeaders },
    );
  }
}
