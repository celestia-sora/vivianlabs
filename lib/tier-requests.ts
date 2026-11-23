import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SELECTED_REQUEST_EMAIL, normalizeEmail } from "./auth/policy.ts";
import { ensureUserAccount, requireAdmin, type AuthIdentityLike } from "./user-tiers.ts";

export const TIER_ACTION_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_REQUEST_DISPLAY_NAME_LENGTH = 120;
export const MAX_REQUEST_REASON_LENGTH = 1000;
export const MAX_REVIEW_NOTE_LENGTH = 500;

export type TierRequestStatus = "pending" | "approved" | "rejected";
export type TierReviewAction = "approve" | "reject";
export type TierRequestErrorCode =
  | "ALREADY_SELECTED"
  | "INVALID_REQUEST"
  | "INVALID_TOKEN"
  | "REQUEST_NOT_FOUND"
  | "ALREADY_REVIEWED"
  | "REQUEST_UNAVAILABLE";

export interface TierRequestRecord {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  reason: string;
  status: TierRequestStatus;
  reviewedBy: string | null;
  reviewNote: string;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TierActionTokenPayload {
  requestId: string;
  action: TierReviewAction;
  exp: number;
}

export interface CreateTierRequestResult {
  request: TierRequestRecord;
  alreadyPending: boolean;
  emailSent: boolean;
  emailError?: string;
  mailtoUrl: string;
  approveUrl: string | null;
  rejectUrl: string | null;
}

export class TierRequestError extends Error {
  status: number;
  code: TierRequestErrorCode;

  constructor(
    message: string,
    status: number,
    code: TierRequestErrorCode,
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RawTierRequestRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  reason: string;
  status: TierRequestStatus;
  reviewed_by: string | null;
  review_note: string;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRequestRow(row: RawTierRequestRow): TierRequestRecord {
  return {
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveBaseUrl(baseUrl?: string): string | null {
  const candidate =
    baseUrl?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`
      : "") ||
    (process.env.VERCEL_URL?.trim() ? `https://${process.env.VERCEL_URL.trim()}` : "");
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function getTierActionSecret(): string | null {
  const secret = process.env.TIER_ACTION_SECRET?.trim() || process.env.VIVIAN_INTERNAL_TOKEN?.trim() || "";
  return secret || null;
}

export function createTierActionToken(
  requestId: string,
  action: TierReviewAction,
  options: { now?: number; ttlMs?: number; secret?: string } = {},
): string {
  if (!isUuid(requestId)) {
    throw new TierRequestError("Invalid tier request ID.", 400, "INVALID_REQUEST");
  }
  const secret = options.secret?.trim() || getTierActionSecret();
  if (!secret) {
    throw new TierRequestError("Tier review secret is not configured.", 503, "REQUEST_UNAVAILABLE");
  }
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? TIER_ACTION_TOKEN_TTL_MS;
  const payload: TierActionTokenPayload = {
    requestId,
    action,
    exp: now + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigB64 = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sigB64}`;
}

export function verifyTierActionToken(
  token: string,
  options: { now?: number; secret?: string } = {},
): TierActionTokenPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const secret = options.secret?.trim() || getTierActionSecret();
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
      !isUuid(parsed.requestId) ||
      (parsed.action !== "approve" && parsed.action !== "reject") ||
      typeof parsed.exp !== "number" ||
      !Number.isFinite(parsed.exp)
    ) {
      return null;
    }
    const now = options.now ?? Date.now();
    if (now > parsed.exp) return null;
    return {
      requestId: parsed.requestId,
      action: parsed.action,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

export function buildSelectedRequestMailto(params: {
  userEmail: string;
  userId: string;
  displayName?: string;
  reason?: string;
  requestId?: string;
}): string {
  const email = normalizeEmail(params.userEmail) || params.userEmail;
  const subject = `[Vivian] Selected Tier Request — ${email}`;
  const lines = [
    "Hello Vivian Labs,",
    "",
    "I would like to request Selected tier access on Vivian.",
    "",
    `Account Email: ${email}`,
    `User ID: ${params.userId}`,
    ...(params.displayName?.trim() ? [`Display Name: ${params.displayName.trim()}`] : []),
    ...(params.requestId ? [`Request ID: ${params.requestId}`] : []),
    ...(params.reason?.trim() ? ["", "Reason:", params.reason.trim()] : []),
  ];
  return `mailto:${SELECTED_REQUEST_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

export function buildTierReviewUrls(
  requestId: string,
  baseUrl?: string,
  reviewPath = "/api/tier-requests/review",
  options: { now?: number; ttlMs?: number; secret?: string } = {},
): { approveUrl: string | null; rejectUrl: string | null } {
  const origin = resolveBaseUrl(baseUrl);
  const secret = options.secret?.trim() || getTierActionSecret();
  if (!origin || !secret || !isUuid(requestId)) {
    return { approveUrl: null, rejectUrl: null };
  }
  const normalizedPath = reviewPath.startsWith("/") ? reviewPath : `/${reviewPath}`;
  const approveToken = createTierActionToken(requestId, "approve", options);
  const rejectToken = createTierActionToken(requestId, "reject", options);
  return {
    approveUrl: `${origin}${normalizedPath}?token=${encodeURIComponent(approveToken)}`,
    rejectUrl: `${origin}${normalizedPath}?token=${encodeURIComponent(rejectToken)}`,
  };
}

export async function sendTierRequestEmail(params: {
  request: TierRequestRecord;
  approveUrl: string | null;
  rejectUrl: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ sent: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!apiKey || !from) {
    return { sent: false };
  }

  const req = params.request;
  const textLines = [
    `New Selected Tier Request on Vivian`,
    ``,
    `Email: ${req.email}`,
    `User ID: ${req.userId}`,
    ...(req.displayName ? [`Name: ${req.displayName}`] : []),
    `Request ID: ${req.id}`,
    `Created: ${req.createdAt}`,
    ...(req.reason ? [``, `Reason:`, req.reason] : []),
    ...(params.approveUrl ? [``, `Approve (14d link): ${params.approveUrl}`] : []),
    ...(params.rejectUrl ? [`Reject (14d link): ${params.rejectUrl}`] : []),
  ];

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1f1630;">
      <h2 style="margin: 0 0 12px;">Vivian Selected Tier Request</h2>
      <p style="margin: 0 0 12px;">A verified account has requested access to the <strong>Selected</strong> tier (20 chats/day, 512 MiB private R2 storage).</p>
      <table style="border-collapse: collapse; margin-bottom: 16px;">
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Email</td><td>${escapeHtml(req.email)}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">User ID</td><td><code>${escapeHtml(req.userId)}</code></td></tr>
        ${req.displayName ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Display Name</td><td>${escapeHtml(req.displayName)}</td></tr>` : ""}
        <tr><td style="padding: 4px 12px 4px 0; font-weight: 600;">Request ID</td><td><code>${escapeHtml(req.id)}</code></td></tr>
        ${req.reason ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: 600; vertical-align: top;">Reason</td><td>${escapeHtml(req.reason)}</td></tr>` : ""}
      </table>
      ${params.approveUrl || params.rejectUrl ? `
        <div style="margin-top: 16px;">
          ${params.approveUrl ? `<a href="${escapeHtml(params.approveUrl)}" style="display: inline-block; padding: 10px 18px; margin-right: 10px; background: #5a3ea6; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">Approve Selected</a>` : ""}
          ${params.rejectUrl ? `<a href="${escapeHtml(params.rejectUrl)}" style="display: inline-block; padding: 10px 18px; background: #ede7f6; color: #2d1b4e; text-decoration: none; border-radius: 8px; font-weight: 600;">Reject</a>` : ""}
        </div>
      ` : ""}
    </div>
  `.trim();

  try {
    const fetcher = params.fetchImpl ?? fetch;
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [SELECTED_REQUEST_EMAIL],
        reply_to: req.email,
        subject: `[Vivian] Selected Tier Request — ${req.email}`,
        text: textLines.join("\n"),
        html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { sent: false, error: `Resend returned ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : "Resend request failed" };
  }
}

export async function createSelectedTierRequest(
  db: SupabaseClient,
  user: AuthIdentityLike,
  input: { displayName?: unknown; reason?: unknown } = {},
  options: { baseUrl?: string; reviewPath?: string; fetchImpl?: typeof fetch; now?: number; secret?: string } = {},
): Promise<CreateTierRequestResult> {
  const account = await ensureUserAccount(db, user);
  if (account.tier !== "free") {
    throw new TierRequestError("Your account already has Selected or higher access.", 400, "ALREADY_SELECTED");
  }

  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim().slice(0, MAX_REQUEST_DISPLAY_NAME_LENGTH) : "";
  const reason =
    typeof input.reason === "string" ? input.reason.trim().slice(0, MAX_REQUEST_REASON_LENGTH) : "";

  const existingPending = await getUserPendingTierRequest(db, account.userId);
  if (existingPending) {
    const mailtoUrl = buildSelectedRequestMailto({
      userEmail: existingPending.email,
      userId: existingPending.userId,
      displayName: existingPending.displayName,
      reason: existingPending.reason,
      requestId: existingPending.id,
    });
    return {
      request: existingPending,
      alreadyPending: true,
      emailSent: false,
      mailtoUrl,
      approveUrl: null,
      rejectUrl: null,
    };
  }

  const insertResult = await db
    .from("vivian_tier_requests")
    .insert({
      user_id: account.userId,
      email: account.email,
      display_name: displayName,
      reason,
      status: "pending",
    })
    .select("*")
    .single();

  if (insertResult.error) {
    if (insertResult.error.code === "23505") {
      const raced = await getUserPendingTierRequest(db, account.userId);
      if (raced) {
        return {
          request: raced,
          alreadyPending: true,
          emailSent: false,
          mailtoUrl: buildSelectedRequestMailto({
            userEmail: raced.email,
            userId: raced.userId,
            displayName: raced.displayName,
            reason: raced.reason,
            requestId: raced.id,
          }),
          approveUrl: null,
          rejectUrl: null,
        };
      }
    }
    throw new TierRequestError("Could not submit tier request.", 503, "REQUEST_UNAVAILABLE");
  }

  const created = mapRequestRow(insertResult.data as RawTierRequestRow);
  const { approveUrl, rejectUrl } = buildTierReviewUrls(created.id, options.baseUrl, options.reviewPath, {
    now: options.now,
    secret: options.secret,
  });
  const mailtoUrl = buildSelectedRequestMailto({
    userEmail: created.email,
    userId: created.userId,
    displayName: created.displayName,
    reason: created.reason,
    requestId: created.id,
  });

  const emailResult = await sendTierRequestEmail({
    request: created,
    approveUrl,
    rejectUrl,
    fetchImpl: options.fetchImpl,
  });

  return {
    request: created,
    alreadyPending: false,
    emailSent: emailResult.sent,
    ...(emailResult.error ? { emailError: emailResult.error } : {}),
    mailtoUrl,
    approveUrl,
    rejectUrl,
  };
}

export async function getUserPendingTierRequest(db: SupabaseClient, userId: string): Promise<TierRequestRecord | null> {
  const { data, error } = await db
    .from("vivian_tier_requests")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) {
    throw new TierRequestError("Tier request service is temporarily unavailable.", 503, "REQUEST_UNAVAILABLE");
  }
  return data ? mapRequestRow(data as RawTierRequestRow) : null;
}

export async function listUserTierRequests(db: SupabaseClient, userId: string): Promise<TierRequestRecord[]> {
  const { data, error } = await db
    .from("vivian_tier_requests")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    throw new TierRequestError("Tier request service is temporarily unavailable.", 503, "REQUEST_UNAVAILABLE");
  }
  return ((data ?? []) as RawTierRequestRow[]).map(mapRequestRow);
}

export async function listAllTierRequests(
  db: SupabaseClient,
  adminUser: AuthIdentityLike,
  options: { status?: TierRequestStatus; limit?: number } = {},
): Promise<TierRequestRecord[]> {
  await requireAdmin(db, adminUser);
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  let query = db.from("vivian_tier_requests").select("*").order("created_at", { ascending: false }).limit(limit);
  if (options.status) {
    query = query.eq("status", options.status);
  }
  const { data, error } = await query;
  if (error) {
    throw new TierRequestError("Tier request service is temporarily unavailable.", 503, "REQUEST_UNAVAILABLE");
  }
  return ((data ?? []) as RawTierRequestRow[]).map(mapRequestRow);
}

async function applyReviewRpc(
  db: SupabaseClient,
  requestId: string,
  action: TierReviewAction,
  reviewedBy: string,
  reviewNote: string,
): Promise<{ request: TierRequestRecord; alreadyReviewed: boolean }> {
  if (!isUuid(requestId)) {
    throw new TierRequestError("Invalid tier request ID.", 400, "INVALID_REQUEST");
  }
  if (action !== "approve" && action !== "reject") {
    throw new TierRequestError("Invalid review action.", 400, "INVALID_REQUEST");
  }
  const note = reviewNote.trim().slice(0, MAX_REVIEW_NOTE_LENGTH);
  const { data, error } = await db.rpc("vivian_review_tier_request", {
    p_request_id: requestId,
    p_action: action,
    p_reviewed_by: reviewedBy,
    p_review_note: note,
  });

  if (error) {
    if (error.code === "P0002") {
      throw new TierRequestError("Tier request not found.", 404, "REQUEST_NOT_FOUND");
    }
    if (error.code === "23514") {
      throw new TierRequestError("Tier request has already been reviewed.", 409, "ALREADY_REVIEWED");
    }
    if (error.code === "22023") {
      throw new TierRequestError("Invalid tier review request.", 400, "INVALID_REQUEST");
    }
    throw new TierRequestError("Tier request service is temporarily unavailable.", 503, "REQUEST_UNAVAILABLE");
  }

  const payload = data as { already_reviewed?: unknown; request?: RawTierRequestRow } | null;
  if (!payload?.request) {
    throw new TierRequestError("Tier request service is temporarily unavailable.", 503, "REQUEST_UNAVAILABLE");
  }
  return {
    request: mapRequestRow(payload.request),
    alreadyReviewed: payload.already_reviewed === true,
  };
}

export async function reviewTierRequest(
  db: SupabaseClient,
  adminUser: AuthIdentityLike,
  input: { requestId: string; action: TierReviewAction; reviewNote?: unknown },
): Promise<{ request: TierRequestRecord; alreadyReviewed: boolean }> {
  const admin = await requireAdmin(db, adminUser);
  const note = typeof input.reviewNote === "string" ? input.reviewNote : "";
  return applyReviewRpc(db, input.requestId, input.action, admin.email || admin.userId, note);
}

export async function reviewTierRequestByToken(
  db: SupabaseClient,
  token: string,
  options: { now?: number; secret?: string; reviewedBy?: string } = {},
): Promise<{ request: TierRequestRecord; action: TierReviewAction; alreadyReviewed: boolean }> {
  const payload = verifyTierActionToken(token, options);
  if (!payload) {
    throw new TierRequestError("This review link is invalid or has expired.", 400, "INVALID_TOKEN");
  }
  const result = await applyReviewRpc(
    db,
    payload.requestId,
    payload.action,
    options.reviewedBy ?? "email-action-link",
    "Reviewed via signed email link",
  );
  return { ...result, action: payload.action };
}
