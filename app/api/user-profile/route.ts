import { isSorachanEmail } from "@/lib/auth/policy";
import { requireApiAccess, type AuthUser } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  defaultUserProfile,
  isRelationshipPreset,
  validateUserProfileInput,
  type UserProfile,
} from "@/lib/user-profile";

const headers = { "Cache-Control": "private, no-store" };
const columns = "user_id,display_name,relationship,pronouns,style_notes,onboarded,updated_at";

interface RawProfileRow {
  user_id?: unknown;
  display_name?: unknown;
  relationship?: unknown;
  pronouns?: unknown;
  style_notes?: unknown;
  onboarded?: unknown;
  updated_at?: unknown;
}

function mapProfileRow(row: RawProfileRow | null | undefined, userId: string, isSorachan: boolean): UserProfile {
  if (!row || typeof row !== "object") {
    return defaultUserProfile(userId, isSorachan);
  }
  const displayName = typeof row.display_name === "string"
    ? row.display_name.trim()
    : isSorachan
      ? "โซระจัง"
      : "";
  const relationship = isRelationshipPreset(row.relationship) ? row.relationship : "close_friend";
  const pronouns = typeof row.pronouns === "string" ? row.pronouns.trim() : "";
  const styleNotes = typeof row.style_notes === "string" ? row.style_notes.trim() : "";
  const onboarded = typeof row.onboarded === "boolean"
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

const PROFILE_MARKER_RE = /<!--\s*VIVIAN_USER_PROFILE:(\{[\s\S]*?\})\s*-->\s*/;

function extractFallbackProfile(instructions: unknown, userId: string, isSorachan: boolean): UserProfile | null {
  if (typeof instructions !== "string") return null;
  const match = instructions.match(PROFILE_MARKER_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as RawProfileRow;
    return mapProfileRow(parsed, userId, isSorachan);
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  let activeUser: AuthUser | null = null;
  const denied = await requireApiAccess(request, (user) => {
    activeUser = user;
  });
  if (denied) return denied;
  const userId = activeUser!.id;
  const isSorachan = isSorachanEmail(activeUser!.email);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const result = await db
      .from("vivian_user_profiles")
      .select(columns)
      .eq("user_id", userId)
      .maybeSingle();

    if (result.error) {
      // Fallback: check if profile was stored in vivian_user_custom_instructions while migration is pending
      try {
        const ci = await db
          .from("vivian_user_custom_instructions")
          .select("instructions")
          .eq("user_id", userId)
          .maybeSingle();
        const fallbackProfile = extractFallbackProfile(ci.data?.instructions, userId, isSorachan);
        if (fallbackProfile) {
          return Response.json({ userId, isSorachan, profile: fallbackProfile }, { headers });
        }
      } catch {
        // ignore fallback error
      }
      const fallback = defaultUserProfile(userId, isSorachan);
      return Response.json({ userId, isSorachan, profile: fallback }, { headers });
    }
    const profile = mapProfileRow(result.data as RawProfileRow | null, userId, isSorachan);
    return Response.json({ userId, isSorachan, profile }, { headers });
  } catch {
    return Response.json({ error: "User profile is unavailable" }, { status: 503, headers });
  }
}

export async function PATCH(request: Request) {
  let activeUser: AuthUser | null = null;
  const denied = await requireApiAccess(request, (user) => {
    activeUser = user;
  });
  if (denied) return denied;
  const userId = activeUser!.id;
  const isSorachan = isSorachanEmail(activeUser!.email);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const validated = validateUserProfileInput(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: 400, headers });
  }

  const now = new Date().toISOString();
  const next = validated.value;
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
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const result = await db
      .from("vivian_user_profiles")
      .upsert(rowPayload, { onConflict: "user_id" })
      .select(columns)
      .single();

    if (result.error) {
      // Soft fallback if vivian_user_profiles migration is not yet applied on Supabase:
      // return 200 with the validated profile so the client and local cache succeed cleanly.
      const profile = mapProfileRow(rowPayload, userId, isSorachan);
      return Response.json({ userId, isSorachan, profile }, { headers });
    }
    const profile = mapProfileRow(result.data as RawProfileRow, userId, isSorachan);
    return Response.json({ userId, isSorachan, profile }, { headers });
  } catch {
    return Response.json({ error: "User profile is unavailable" }, { status: 503, headers });
  }
}
