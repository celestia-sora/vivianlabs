import type { SupabaseClient } from "@supabase/supabase-js";

export async function resetCompanionData(supabase: SupabaseClient, userKey: string): Promise<void> {
  const ownerKey = userKey.trim();
  if (!ownerKey) throw new Error("A companion identity is required");
  const conversations = await supabase.from("conversations").select("id").eq("user_key", ownerKey);
  if (conversations.error) throw conversations.error;
  const ids = (conversations.data ?? []).map((conversation: { id: string }) => conversation.id);
  if (ids.length) {
    const messages = await supabase.from("messages").delete().in("conversation_id", ids);
    if (messages.error) throw messages.error;
  }
  // Each step is scoped to ownerKey and idempotent, so a partial provider failure
  // can be retried without affecting any other user's data.
  for (const table of ["conversations", "memories", "companion_state", "memory_consolidation_runs"]) {
    const result = await supabase.from(table).delete().eq("user_key", ownerKey);
    if (result.error) throw result.error;
  }
  // D7 (owner confirmed 2026-11-09): Reset Vivian KEEPS custom instructions.
  // The persona profile persists across Reset; clearing custom instructions
  // is a separate explicit action in Settings.
  const checks = await Promise.all(["conversations", "memories", "companion_state", "memory_consolidation_runs"].map(table =>
    supabase.from(table).select("*", { count: "exact", head: true }).eq("user_key", ownerKey)));
  if (ids.length) checks.push(await supabase.from("messages").select("*", { count: "exact", head: true }).in("conversation_id", ids));
  for (const check of checks) {
    if (check.error) throw check.error;
    if (check.count !== 0) throw new Error("Companion reset could not be verified");
  }
}
