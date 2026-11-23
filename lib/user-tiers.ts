import type { SupabaseClient } from "@supabase/supabase-js";
import { PRIMARY_LEGACY_EMAIL, isSorachanEmail, normalizeEmail } from "./auth/policy.ts";

export type UserTier = "free" | "selected" | "sorachan";

export type TierErrorCode =
  | "TIER_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "ADMIN_REQUIRED"
  | "TIER_UNAVAILABLE";

export const FREE_DAILY_CHAT_LIMIT = 5;
export const SELECTED_DAILY_CHAT_LIMIT = 20;
export const SELECTED_R2_STORAGE_LIMIT_BYTES = 512 * 1024 * 1024;

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const TIER_ORDER: Record<UserTier, number> = { free: 0, selected: 1, sorachan: 2 };

export interface AuthIdentityLike {
  id: string;
  email?: string | null;
}

export interface TierCapabilities {
  tier: UserTier;
  dailyChatLimit: number | null;
  canUseCloudModels: boolean;
  canUseCloudScenes: boolean;
  canViewSharedModels: boolean;
  personalStorageLimitBytes: number | null;
  isAdmin: boolean;
}

export interface UserAccountRecord {
  userId: string;
  email: string;
  tier: UserTier;
  legacyClaimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatQuotaStatus {
  allowed: boolean;
  tier: UserTier;
  used: number;
  limit: number | null;
  remaining: number | null;
  usageDate: string;
  resetAt: string;
}

export interface UserTierSummary {
  userId: string;
  email: string;
  tier: UserTier;
  capabilities: TierCapabilities;
  chatQuota: ChatQuotaStatus;
  storage: {
    usedBytes: number;
    limitBytes: number | null;
  };
}

export class TierError extends Error {
  status: number;
  code: TierErrorCode;
  requiredTier?: UserTier;
  meta?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code: TierErrorCode,
    requiredTier?: UserTier,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requiredTier = requiredTier;
    this.meta = meta;
  }
}

export function tierErrorBody(error: TierError): Record<string, unknown> {
  return {
    error: error.message,
    status: error.status,
    code: error.code,
    ...(error.requiredTier ? { requiredTier: error.requiredTier } : {}),
    ...(error.meta ?? {}),
  };
}

export function tierErrorResponse(error: TierError): Response {
  return Response.json(tierErrorBody(error), {
    status: error.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function bangkokDateKey(now: Date | number = Date.now()): string {
  const ms = typeof now === "number" ? now : now.getTime();
  return new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextBangkokMidnightIso(now: Date | number = Date.now()): string {
  const ms = typeof now === "number" ? now : now.getTime();
  const bangkokMs = ms + BANGKOK_OFFSET_MS;
  const startOfDayBangkokMs = Math.floor(bangkokMs / DAY_MS) * DAY_MS;
  return new Date(startOfDayBangkokMs + DAY_MS - BANGKOK_OFFSET_MS).toISOString();
}

export function dailyChatLimitForTier(tier: UserTier): number | null {
  if (tier === "free") return FREE_DAILY_CHAT_LIMIT;
  if (tier === "selected") return SELECTED_DAILY_CHAT_LIMIT;
  return null;
}

export function hasRequiredTier(tier: UserTier, minTier: UserTier): boolean {
  return TIER_ORDER[tier] >= TIER_ORDER[minTier];
}

export function getTierCapabilities(tier: UserTier): TierCapabilities {
  if (tier === "sorachan") {
    return {
      tier,
      dailyChatLimit: null,
      canUseCloudModels: true,
      canUseCloudScenes: true,
      canViewSharedModels: true,
      personalStorageLimitBytes: null,
      isAdmin: true,
    };
  }
  if (tier === "selected") {
    return {
      tier,
      dailyChatLimit: SELECTED_DAILY_CHAT_LIMIT,
      canUseCloudModels: true,
      canUseCloudScenes: true,
      canViewSharedModels: false,
      personalStorageLimitBytes: SELECTED_R2_STORAGE_LIMIT_BYTES,
      isAdmin: false,
    };
  }
  return {
    tier: "free",
    dailyChatLimit: FREE_DAILY_CHAT_LIMIT,
    canUseCloudModels: false,
    canUseCloudScenes: false,
    canViewSharedModels: false,
    personalStorageLimitBytes: 0,
    isAdmin: false,
  };
}

export function resolveEffectiveTier(email: string | null | undefined, storedTier?: string | null): UserTier {
  if (isSorachanEmail(email)) return "sorachan";
  if (storedTier === "selected") return "selected";
  return "free";
}

interface RawAccountRow {
  user_id: string;
  email: string;
  tier: string;
  legacy_claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapAccountRow(row: RawAccountRow, emailOverride?: string): UserAccountRecord {
  const email = emailOverride || normalizeEmail(row.email);
  return {
    userId: row.user_id,
    email,
    tier: resolveEffectiveTier(email, row.tier),
    legacyClaimedAt: row.legacy_claimed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureUserAccount(db: SupabaseClient, user: AuthIdentityLike): Promise<UserAccountRecord> {
  const userId = typeof user.id === "string" ? user.id.trim() : "";
  const email = normalizeEmail(user.email);
  if (!userId) throw new TierError("Please sign in.", 401, "TIER_REQUIRED");
  if (!email) throw new TierError("A verified email is required.", 403, "TIER_REQUIRED");

  const now = new Date().toISOString();
  const initialTier: UserTier = isSorachanEmail(email) ? "sorachan" : "free";

  const existingResult = await db
    .from("vivian_user_accounts")
    .select("user_id,email,tier,legacy_claimed_at,created_at,updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingResult.error) {
    throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
  }

  let row = existingResult.data as RawAccountRow | null;
  if (!row) {
    const insertResult = await db
      .from("vivian_user_accounts")
      .upsert(
        { user_id: userId, email, tier: initialTier, updated_at: now },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
    if (insertResult.error) {
      throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
    }
    const loaded = await db
      .from("vivian_user_accounts")
      .select("user_id,email,tier,legacy_claimed_at,created_at,updated_at")
      .eq("user_id", userId)
      .single();
    if (loaded.error || !loaded.data) {
      throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
    }
    row = loaded.data as RawAccountRow;
  }

  const effectiveTier = resolveEffectiveTier(email, row.tier);
  if (row.tier !== effectiveTier || normalizeEmail(row.email) !== email) {
    const synced = await db
      .from("vivian_user_accounts")
      .update({ email, tier: effectiveTier, updated_at: now })
      .eq("user_id", userId)
      .select("user_id,email,tier,legacy_claimed_at,created_at,updated_at")
      .single();
    if (synced.error || !synced.data) {
      throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
    }
    row = synced.data as RawAccountRow;
  }

  const account = mapAccountRow(row, email);

  if (email === PRIMARY_LEGACY_EMAIL && !account.legacyClaimedAt) {
    const claim = await db.rpc("vivian_claim_legacy_data", { p_user_id: userId });
    if (claim.error) {
      throw new TierError("Account migration is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
    }
    const claimData = claim.data as { claimed_at?: string | null } | null;
    if (claimData && typeof claimData.claimed_at === "string") {
      account.legacyClaimedAt = claimData.claimed_at;
    }
  }

  return account;
}

export async function getUserTier(db: SupabaseClient, user: AuthIdentityLike): Promise<UserTier> {
  const account = await ensureUserAccount(db, user);
  return account.tier;
}

export async function getDailyChatQuotaStatus(
  db: SupabaseClient,
  userId: string,
  tier: UserTier,
  now: Date | number = Date.now(),
): Promise<ChatQuotaStatus> {
  const usageDate = bangkokDateKey(now);
  const resetAt = nextBangkokMidnightIso(now);
  const limit = dailyChatLimitForTier(tier);

  const { data, error } = await db
    .from("vivian_daily_chat_usage")
    .select("used_count")
    .eq("user_id", userId)
    .eq("usage_date", usageDate)
    .maybeSingle();

  if (error) {
    if (tier === "sorachan") {
      return { allowed: true, tier, used: 0, limit: null, remaining: null, usageDate, resetAt };
    }
    throw new TierError("Could not read daily chat quota.", 503, "TIER_UNAVAILABLE");
  }

  const used = typeof data?.used_count === "number" && Number.isFinite(data.used_count) ? data.used_count : 0;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const allowed = limit === null ? true : used < limit;
  return { allowed, tier, used, limit, remaining, usageDate, resetAt };
}

export async function consumeChatQuota(
  db: SupabaseClient,
  user: AuthIdentityLike,
  options: { mode?: string; now?: Date | number } = {},
): Promise<ChatQuotaStatus> {
  const now = options.now ?? Date.now();
  const usageDate = bangkokDateKey(now);
  const resetAt = nextBangkokMidnightIso(now);
  const mode = options.mode ?? "chat";

  let account: UserAccountRecord;
  try {
    account = await ensureUserAccount(db, user);
  } catch (error) {
    if (isSorachanEmail(user.email)) {
      return { allowed: true, tier: "sorachan", used: 0, limit: null, remaining: null, usageDate, resetAt };
    }
    throw error;
  }

  const tier = account.tier;
  if (mode === "greeting" || mode === "idle") {
    const status = await getDailyChatQuotaStatus(db, account.userId, tier, now);
    return { ...status, allowed: true };
  }

  if (tier === "sorachan") {
    return { allowed: true, tier: "sorachan", used: 0, limit: null, remaining: null, usageDate, resetAt };
  }

  const limit = dailyChatLimitForTier(tier)!;
  const { data, error } = await db.rpc("vivian_consume_chat_quota", {
    p_user_id: account.userId,
    p_limit: limit,
    p_usage_date: usageDate,
  });

  if (error || !data || typeof data !== "object") {
    throw new TierError("Could not verify daily chat quota.", 503, "TIER_UNAVAILABLE");
  }

  const payload = data as { allowed?: unknown; used?: unknown; remaining?: unknown; usage_date?: unknown };
  const used = typeof payload.used === "number" ? payload.used : Number(payload.used ?? 0);
  const remaining = typeof payload.remaining === "number" ? payload.remaining : Math.max(0, limit - used);
  return {
    allowed: payload.allowed === true,
    tier,
    used,
    limit,
    remaining,
    usageDate: typeof payload.usage_date === "string" ? payload.usage_date : usageDate,
    resetAt,
  };
}

export async function assertAndConsumeChatQuota(
  db: SupabaseClient,
  user: AuthIdentityLike,
  options: { mode?: string; now?: Date | number } = {},
): Promise<ChatQuotaStatus> {
  const status = await consumeChatQuota(db, user, options);
  if (!status.allowed) {
    throw new TierError(
      `Daily chat limit reached (${status.limit} messages/day). Resets at midnight (Asia/Bangkok).`,
      403,
      "QUOTA_EXCEEDED",
      status.tier === "free" ? "selected" : undefined,
      { quota: status },
    );
  }
  return status;
}

export async function refundChatQuota(
  db: SupabaseClient,
  userId: string,
  usageDate = bangkokDateKey(),
): Promise<boolean> {
  const trimmed = userId.trim();
  if (!trimmed) return false;
  try {
    const { data, error } = await db.rpc("vivian_refund_chat_quota", {
      p_user_id: trimmed,
      p_usage_date: usageDate,
    });
    if (error || !data || typeof data !== "object") return false;
    return (data as { refunded?: unknown }).refunded === true;
  } catch {
    return false;
  }
}

export async function getUserStorageUsedBytes(db: SupabaseClient, userId: string): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("vivian_storage_objects")
      .select("byte_size")
      .eq("user_id", userId)
      .order("id")
      .range(offset, offset + 999);
    if (error || !data) {
      throw new TierError("Storage usage could not be verified.", 503, "TIER_UNAVAILABLE");
    }
    for (const row of data) {
      const size = Number((row as { byte_size: unknown }).byte_size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new TierError("Storage usage could not be verified.", 503, "TIER_UNAVAILABLE");
      }
      total += size;
    }
    if (data.length < 1000) break;
  }
  return total;
}

export async function getUserTierSummary(
  db: SupabaseClient,
  user: AuthIdentityLike,
  now: Date | number = Date.now(),
): Promise<UserTierSummary> {
  const account = await ensureUserAccount(db, user);
  const capabilities = getTierCapabilities(account.tier);
  const [chatQuota, usedBytes] = await Promise.all([
    getDailyChatQuotaStatus(db, account.userId, account.tier, now),
    account.tier === "free" ? Promise.resolve(0) : getUserStorageUsedBytes(db, account.userId).catch(() => 0),
  ]);
  return {
    userId: account.userId,
    email: account.email,
    tier: account.tier,
    capabilities,
    chatQuota,
    storage: {
      usedBytes,
      limitBytes: capabilities.personalStorageLimitBytes,
    },
  };
}

export async function requireTier(
  db: SupabaseClient,
  user: AuthIdentityLike,
  minTier: UserTier,
): Promise<UserAccountRecord> {
  if (minTier === "sorachan") {
    return requireAdmin(db, user);
  }
  const account = await ensureUserAccount(db, user);
  if (!hasRequiredTier(account.tier, minTier)) {
    throw new TierError(
      `This feature requires the ${minTier === "selected" ? "Selected" : minTier} tier.`,
      403,
      "TIER_REQUIRED",
      minTier,
    );
  }
  return account;
}

export async function requireAdmin(
  db: SupabaseClient,
  user: AuthIdentityLike,
): Promise<UserAccountRecord> {
  if (!isSorachanEmail(user.email)) {
    throw new TierError("Admin access is restricted to Sorachan accounts.", 403, "ADMIN_REQUIRED", "sorachan");
  }
  return ensureUserAccount(db, user);
}

export async function setUserTier(
  db: SupabaseClient,
  targetUserId: string,
  tier: "free" | "selected",
): Promise<UserAccountRecord> {
  const trimmed = targetUserId.trim();
  if (!trimmed) throw new TierError("Target user ID is required.", 400, "TIER_UNAVAILABLE");

  const existing = await db
    .from("vivian_user_accounts")
    .select("user_id,email,tier,legacy_claimed_at,created_at,updated_at")
    .eq("user_id", trimmed)
    .maybeSingle();

  if (existing.error) {
    throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
  }
  if (!existing.data) {
    throw new TierError("User account not found.", 404, "TIER_UNAVAILABLE");
  }
  const row = existing.data as RawAccountRow;
  if (isSorachanEmail(row.email)) {
    throw new TierError("Cannot modify a Sorachan admin account tier.", 400, "ADMIN_REQUIRED");
  }

  const updated = await db
    .from("vivian_user_accounts")
    .update({ tier, updated_at: new Date().toISOString() })
    .eq("user_id", trimmed)
    .select("user_id,email,tier,legacy_claimed_at,created_at,updated_at")
    .single();

  if (updated.error || !updated.data) {
    throw new TierError("Account tier service is temporarily unavailable.", 503, "TIER_UNAVAILABLE");
  }
  return mapAccountRow(updated.data as RawAccountRow);
}
