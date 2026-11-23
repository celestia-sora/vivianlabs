import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { decayCompanionState, type CompanionState, defaultCompanionState, normalizeMood, clampScore } from "@/lib/companion";

type Row = {
  affinity: number;
  trust: number;
  familiarity: number;
  mood: string;
  mood_intensity: number;
  conversation_summary: string | null;
  last_idle_at: string | null;
  last_interaction_at: string | null;
};

function fromRow(row: Row): CompanionState {
  return {
    affinity: clampScore(row.affinity),
    trust: clampScore(row.trust),
    familiarity: clampScore(row.familiarity),
    mood: normalizeMood(row.mood),
    moodIntensity: clampScore(row.mood_intensity),
    conversationSummary: row.conversation_summary?.trim() ?? "",
    lastIdleAt: row.last_idle_at,
    lastInteractionAt: row.last_interaction_at,
  };
}

export function normalizeCompanionUserKey(userKey: string): string {
  const trimmed = userKey.trim();
  if (!trimmed) throw new Error("A companion identity is required");
  return trimmed;
}

export async function loadCompanionState(userKey: string, db?: SupabaseClient): Promise<CompanionState> {
  const fallback = defaultCompanionState();
  const ownerKey = userKey.trim();
  if (!ownerKey) return fallback;
  try {
    const supabase = db ?? getSupabaseAdmin();
    const { data, error } = await supabase
      .from("companion_state")
      .select("affinity,trust,familiarity,mood,mood_intensity,conversation_summary,last_idle_at,last_interaction_at")
      .eq("user_key", ownerKey)
      .maybeSingle();
    if (error || !data) return fallback;
    return decayCompanionState(fromRow(data as Row));
  } catch (error) {
    console.warn("Companion state unavailable", error);
    return fallback;
  }
}

export async function saveCompanionState(userKey: string, state: CompanionState, db?: SupabaseClient) {
  const ownerKey = userKey.trim();
  if (!ownerKey) return;
  try {
    const supabase = db ?? getSupabaseAdmin();
    await supabase.from("companion_state").upsert({
      user_key: ownerKey,
      affinity: state.affinity,
      trust: state.trust,
      familiarity: state.familiarity,
      mood: state.mood,
      mood_intensity: state.moodIntensity,
      conversation_summary: state.conversationSummary.slice(0, 1800),
      last_idle_at: state.lastIdleAt,
      last_interaction_at: state.lastInteractionAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_key" });
  } catch (error) {
    console.warn("Companion state save unavailable", error);
  }
}

export async function loadMemorySummary(userKey: string, db?: SupabaseClient): Promise<string> {
  const ownerKey = normalizeCompanionUserKey(userKey);
  const supabase = db ?? getSupabaseAdmin();
  const { data, error } = await supabase
    .from("companion_state")
    .select("memory_summary")
    .eq("user_key", ownerKey)
    .maybeSingle();
  if (error) throw error;
  return typeof data?.memory_summary === "string" ? data.memory_summary : "";
}

export async function saveMemorySummary(userKey: string, summary: string, db?: SupabaseClient): Promise<void> {
  const ownerKey = normalizeCompanionUserKey(userKey);
  const supabase = db ?? getSupabaseAdmin();
  const { error } = await supabase.from("companion_state").upsert({
    user_key: ownerKey,
    memory_summary: summary.trim().slice(0, 2000),
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_key" });
  if (error) throw error;
}
