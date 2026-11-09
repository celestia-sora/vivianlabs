import type { SupabaseClient } from "@supabase/supabase-js";

export async function resetCompanionData(supabase: SupabaseClient, userKey: string): Promise<void> {
  if (!userKey.trim()) throw new Error("A companion identity is required");
  const conversations = await supabase.from("conversations").select("id").eq("user_key", userKey);
  if (conversations.error) throw conversations.error;
  const ids = (conversations.data ?? []).map((conversation: { id: string }) => conversation.id);
  if (ids.length) {
    const messages = await supabase.from("messages").delete().in("conversation_id", ids);
    if (messages.error) throw messages.error;
  }
  // Each step is scoped and idempotent, so a partial provider failure can be
  // retried. Never report success until the resulting cloud state is checked.
  for (const table of ["conversations", "memories", "companion_state"]) {
    const result = await supabase.from(table).delete().eq("user_key", userKey);
    if (result.error) throw result.error;
  }
  // D7 (owner confirmed 2026-11-09): Reset Vivian KEEPS custom instructions.
  // The persona profile stored in vivian_custom_instructions (and its
  // custom_instruction_versions history) persists across Reset; clearing
  // custom instructions is a separate explicit action in Settings.
  // (Previously Reset deleted the singleton here — removed in Phase 3.)
  // Phase 2: consolidation runs are global (no user_key); clearing them is part
  // of "reset clears every new table" (plan §4.8).
  const runs = await supabase.from("memory_consolidation_runs").delete().not("id", "is", null);
  if (runs.error) throw runs.error;
  const checks = await Promise.all(["conversations", "memories", "companion_state"].map(table =>
    supabase.from(table).select("*", { count: "exact", head: true }).eq("user_key", userKey)));
  checks.push(await supabase.from("memory_consolidation_runs").select("*", { count: "exact", head: true }));
  if (ids.length) checks.push(await supabase.from("messages").select("*", { count: "exact", head: true }).in("conversation_id", ids));
  for (const check of checks) {
    if (check.error) throw check.error;
    if (check.count !== 0) throw new Error("Companion reset could not be verified");
  }
}
