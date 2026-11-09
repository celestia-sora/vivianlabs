import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canAcquireLease,
  classifyWrite,
  decayedImportance01,
  importance01Of,
  importanceToLegacy,
  isExpiredMood,
  keywordSimilarity,
  normalizeForMatch,
  bumpCounter,
  CONSOLIDATION_ITEM_CAP,
  type ExtractedItem,
  type V2MemoryRow,
} from "@/lib/memory-v2";

const userKey = "default";

export type ConsolidationStats = {
  ok: boolean;
  mergedDuplicates: number;
  resolvedContradictions: number;
  decayed: number;
  expiredMoodsDropped: number;
  episodesRolled: number;
  staleEmbeddings: number;
  capped: boolean;
  reason?: string;
};

export type MemoryWriteResult = "inserted" | "duplicate-bumped" | "contradiction-superseded" | "secret-blocked" | "skipped";

/**
 * Phase 2 write path: exact/near-dupe bumps importance + timestamps and
 * merges source ids; contradiction inserts and supersedes the old row;
 * otherwise a plain insert. All writes also populate the v2 columns
 * (type, importance_01, source_message_ids) so legacy readers keep working.
 * Secret pre-filter re-checks here as defence in depth.
 */
export async function writeMemoryItem(
  supabase: SupabaseClient,
  item: ExtractedItem,
): Promise<MemoryWriteResult> {
  const { isSecretLike } = await import("@/lib/memory-v2");
  if (isSecretLike(item.memory)) {
    bumpCounter("secret_prefilter_hits");
    return "secret-blocked";
  }
  const candidateRows = await loadCandidates(supabase, item.type);
  if (candidateRows === null) return "skipped";
  const decision = classifyWrite(item, candidateRows);
  const now = new Date().toISOString();
  if (decision.action === "duplicate") {
    bumpCounter("dedupe_hits");
    const matched = candidateRows.find((row) => row.id === decision.matchedId);
    if (!matched) return "skipped";
    const mergedSources = Array.from(new Set([...(matched.source_message_ids ?? []), ...item.source_message_ids]));
    const current01 = importance01Of(matched);
    const bumped01 = Math.min(1, current01 + 0.05);
    const { error } = await supabase.from("memories").update({
      importance: importanceToLegacy(bumped01),
      importance_01: bumped01,
      type: item.type,
      source_message_ids: mergedSources,
      last_accessed_at: now,
      last_used_at: now,
      access_count: (matched.access_count ?? 0) + 1,
      updated_at: now,
    }).eq("user_key", userKey).eq("id", matched.id);
    if (error) return "skipped";
    return "duplicate-bumped";
  }
  if (decision.action === "contradiction") {
    bumpCounter("supersede_hits");
    const inserted = await supabase.from("memories").insert({
      user_key: userKey,
      memory: item.memory.trim(),
      category: item.category,
      importance: item.importance,
      importance_01: item.importance01,
      type: item.type,
      source_message_ids: item.source_message_ids,
      last_accessed_at: now,
      last_used_at: now,
      updated_at: now,
    }).select("id").single();
    if (inserted.error || !inserted.data) return "skipped";
    const { error } = await supabase.from("memories").update({
      superseded_by: inserted.data.id,
      updated_at: now,
    }).eq("user_key", userKey).eq("id", decision.matchedId);
    if (error) return "skipped";
    return "contradiction-superseded";
  }
  const { error } = await supabase.from("memories").insert({
    user_key: userKey,
    memory: item.memory.trim(),
    category: item.category,
    importance: item.importance,
    importance_01: item.importance01,
    type: item.type,
    source_message_ids: item.source_message_ids,
    last_accessed_at: now,
    last_used_at: now,
    updated_at: now,
  });
  if (error) return "skipped";
  return "inserted";
}

async function loadCandidates(supabase: SupabaseClient, type: string): Promise<V2MemoryRow[] | null> {
  const { data, error } = await supabase
    .from("memories")
    .select("id,memory,category,type,importance,importance_01,superseded_by,source_message_ids,access_count,last_accessed_at,last_used_at,updated_at,created_at")
    .eq("user_key", userKey)
    .eq("type", type)
    .is("superseded_by", null)
    .limit(60);
  if (error) return null;
  return (data ?? []) as V2MemoryRow[];
}

/**
 * On-demand consolidation. Single-flight lease via memory_consolidation_runs,
 * idempotent steps, hard caps, never deletes rows (superseded_by only).
 * Failed runs mark status=failed and change nothing visible.
 */
export async function runConsolidation(supabase: SupabaseClient): Promise<ConsolidationStats> {
  const started = Date.now();
  const stats: ConsolidationStats = {
    ok: false,
    mergedDuplicates: 0,
    resolvedContradictions: 0,
    decayed: 0,
    expiredMoodsDropped: 0,
    episodesRolled: 0,
    staleEmbeddings: 0,
    capped: false,
  };
  let runId: string | null = null;
  try {
    const { data: running } = await supabase
      .from("memory_consolidation_runs")
      .select("id,started_at,status")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!canAcquireLease(running as never, started)) {
      stats.reason = "lease-held";
      return stats;
    }
    const inserted = await supabase
      .from("memory_consolidation_runs")
      .insert({ status: "running", stats })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      stats.reason = "lease-insert-failed";
      return stats;
    }
    runId = inserted.data.id as string;
    bumpCounter("consolidation_runs");

    const { data, error } = await supabase
      .from("memories")
      .select("id,memory,category,type,importance,importance_01,superseded_by,last_accessed_at,last_used_at,updated_at,created_at,embedding,embedding_model")
      .eq("user_key", userKey)
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(CONSOLIDATION_ITEM_CAP * 2);
    if (error || !data) throw new Error("memory load failed");
    const rows = data as V2MemoryRow[];
    let processed = 0;
    const nowIso = new Date().toISOString();

    // Stale/missing embeddings are counted now; the re-embed batch is a stub
    // (no provider until the D4 eval) so this step performs no writes.
    stats.staleEmbeddings = rows.filter((row) => !row.embedding && !row.embedding_model).length;

    for (const row of rows) {
      if (processed >= CONSOLIDATION_ITEM_CAP) {
        stats.capped = true;
        break;
      }
      processed += 1;
      // Drop expired moods: supersede to a tombstone row instead of deleting.
      if (isExpiredMood(row, started)) {
        const tombstone = await supabase.from("memories").insert({
          user_key: userKey,
          memory: `mood expired (${row.id})`,
          category: "general",
          importance: 1,
          importance_01: 0,
          type: "mood",
          updated_at: nowIso,
        }).select("id").single();
        if (!tombstone.error && tombstone.data) {
          await supabase.from("memories").update({ superseded_by: tombstone.data.id, updated_at: nowIso })
            .eq("user_key", userKey).eq("id", row.id);
          stats.expiredMoodsDropped += 1;
        }
        continue;
      }
      // Decay long-idle importance (lower only, floor 0.1).
      const decayed = decayedImportance01(importance01Of(row), row.last_accessed_at ?? row.last_used_at ?? row.updated_at, started);
      if (decayed < importance01Of(row)) {
        const { error: decayError } = await supabase.from("memories").update({
          importance: importanceToLegacy(decayed),
          importance_01: decayed,
          updated_at: nowIso,
        }).eq("user_key", userKey).eq("id", row.id);
        if (!decayError) stats.decayed += 1;
        continue;
      }
      // Merge near-dupes within the batch (same type, Jaccard >= 0.85).
      for (const other of rows) {
        if (other.id === row.id || processed >= CONSOLIDATION_ITEM_CAP) continue;
        const otherType = other.type ?? null;
        const rowType = row.type ?? null;
        if (otherType !== rowType) continue;
        if (keywordSimilarity(row.memory, other.memory) < 0.85) continue;
        if (normalizeForMatch(row.memory) === normalizeForMatch(other.memory)) continue;
        const newer = (other.updated_at ?? "") > (row.updated_at ?? "") ? other : row;
        const older = newer === other ? row : other;
        const current01 = importance01Of(newer);
        const bumped = Math.min(1, current01 + 0.05);
        await supabase.from("memories").update({
          importance: importanceToLegacy(bumped),
          importance_01: bumped,
          last_accessed_at: nowIso,
          updated_at: nowIso,
        }).eq("user_key", userKey).eq("id", newer.id);
        const tombstone = await supabase.from("memories").insert({
          user_key: userKey,
          memory: `consolidated duplicate (${older.id})`,
          category: "general",
          importance: 1,
          importance_01: 0,
          type: "fact",
          updated_at: nowIso,
        }).select("id").single();
        if (!tombstone.error && tombstone.data) {
          await supabase.from("memories").update({ superseded_by: tombstone.data.id, updated_at: nowIso })
            .eq("user_key", userKey).eq("id", older.id);
          stats.mergedDuplicates += 1;
          processed += 1;
        }
        break;
      }
    }
    stats.ok = true;
    return stats;
  } catch (error) {
    bumpCounter("consolidation_failures");
    stats.reason = error instanceof Error ? error.message.slice(0, 120) : "failed";
    console.warn("Consolidation failed", { code: "MEMORY_CONSOLIDATION_FAILED" });
    return stats;
  } finally {
    if (runId) {
      try {
        await supabase.from("memory_consolidation_runs").update({
          status: stats.ok ? "done" : "failed",
          finished_at: new Date().toISOString(),
          stats,
        }).eq("id", runId);
      } catch {
        // Lease-row finalization never blocks chat.
      }
    }
  }
}
