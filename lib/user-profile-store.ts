import type { SupabaseClient } from "@supabase/supabase-js";
import {
  defaultUserProfile,
  isRelationshipPreset,
  type RelationshipPreset,
  type UserProfile,
} from "./user-profile";

const COLUMNS = "user_id,display_name,relationship,pronouns,style_notes,onboarded,updated_at";
const FALLBACK_KEY_PREFIX = "profile:";

interface RawProfileRow {
  user_id?: unknown;
  display_name?: unknown;
  relationship?: unknown;
  pronouns?: unknown;
  style_notes?: unknown;
  onboarded?: unknown;
  updated_at?: unknown;
}

export function profileFallbackRowId(userId: string): string {
  return `${FALLBACK_KEY_PREFIX}${userId}`;
}

export function mapUserProfileRow(
  row: RawProfileRow | null | undefined,
  userId: string,
  isSorachan: boolean,
): UserProfile {
  if (!row || typeof row !== "object") {
    return defaultUserProfile(userId, isSorachan);
  }
  const displayName =
    typeof row.display_name === "string"
      ? row.display_name.trim()
      : isSorachan
        ? "โซระจัง"
        : "";
  const relationship: RelationshipPreset = isRelationshipPreset(row.relationship)
    ? row.relationship
    : "close_friend";
  const pronouns = typeof row.pronouns === "string" ? row.pronouns.trim() : "";
  const styleNotes = typeof row.style_notes === "string" ? row.style_notes.trim() : "";
  const onboarded =
    typeof row.onboarded === "boolean"
      ? row.onboarded || isSorachan || Boolean(displayName)
      : isSorachan || Boolean(displayName);
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : null;

  return {
    userId,
    displayName: displayName || (isSorachan ? "โซระจัง" : ""),
    relationship,
    pronouns,
    styleNotes,
    onboarded,
    updatedAt,
  };
}

function parseFallbackJson(raw: unknown, userId: string, isSorachan: boolean): UserProfile | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    if (!parsed || typeof parsed !== "object") return null;
    const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
    const relationship: RelationshipPreset = isRelationshipPreset(parsed.relationship)
      ? parsed.relationship
      : "close_friend";
    const pronouns = typeof parsed.pronouns === "string" ? parsed.pronouns.trim() : "";
    const styleNotes = typeof parsed.styleNotes === "string" ? parsed.styleNotes.trim() : "";
    const onboarded = Boolean(parsed.onboarded) || isSorachan || Boolean(displayName);
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    return {
      userId,
      displayName: displayName || (isSorachan ? "โซระจัง" : ""),
      relationship,
      pronouns,
      styleNotes,
      onboarded,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export async function loadUserProfileServer(
  db: SupabaseClient,
  userId: string,
  isSorachan: boolean,
): Promise<UserProfile> {
  const fallback = defaultUserProfile(userId, isSorachan);
  try {
    const result = await db
      .from("vivian_user_profiles")
      .select(COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();

    if (!result.error && result.data) {
      return mapUserProfileRow(result.data as RawProfileRow, userId, isSorachan);
    }
  } catch {
    // Fall through to fallback storage when migration is not applied yet.
  }

  // Fallback storage in `vivian_user_custom_instructions` using `profile:${userId}`
  // so it never collides with the user's `customInstructions` row (`userId`)
  // and survives even before the `vivian_user_profiles` SQL migration is run.
  try {
    const ciFallback = await db
      .from("vivian_user_custom_instructions")
      .select("instructions")
      .eq("user_id", profileFallbackRowId(userId))
      .maybeSingle();

    if (!ciFallback.error && ciFallback.data) {
      const parsed = parseFallbackJson(
        (ciFallback.data as { instructions?: unknown }).instructions,
        userId,
        isSorachan,
      );
      if (parsed) return parsed;
    }
  } catch {
    // Soft-fail to default profile.
  }

  return fallback;
}

export async function saveUserProfileServer(
  db: SupabaseClient,
  userId: string,
  isSorachan: boolean,
  next: Omit<UserProfile, "userId" | "updatedAt">,
): Promise<UserProfile> {
  const now = new Date().toISOString();
  const rowPayload = {
    user_id: userId,
    display_name: next.displayName,
    relationship: next.relationship,
    pronouns: next.pronouns,
    style_notes: next.styleNotes,
    onboarded: next.onboarded,
    updated_at: now,
  };

  try {
    const result = await db
      .from("vivian_user_profiles")
      .upsert(rowPayload, { onConflict: "user_id" })
      .select(COLUMNS)
      .single();

    if (!result.error && result.data) {
      return mapUserProfileRow(result.data as RawProfileRow, userId, isSorachan);
    }
  } catch {
    // Fall through to fallback table.
  }

  // Fallback persistence in `vivian_user_custom_instructions` under `profile:${userId}`
  const savedProfile: UserProfile = mapUserProfileRow(rowPayload, userId, isSorachan);
  const serialized = JSON.stringify({
    displayName: savedProfile.displayName,
    relationship: savedProfile.relationship,
    pronouns: savedProfile.pronouns,
    styleNotes: savedProfile.styleNotes,
    onboarded: savedProfile.onboarded,
    updatedAt: savedProfile.updatedAt,
  }).slice(0, 2000);

  const fallbackRes = await db
    .from("vivian_user_custom_instructions")
    .upsert(
      {
        user_id: profileFallbackRowId(userId),
        instructions: serialized,
        updated_at: now,
      },
      { onConflict: "user_id" },
    );

  if (fallbackRes.error) {
    throw fallbackRes.error;
  }

  return savedProfile;
}
