import { requireApiAccess } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { memoryConsolidationEnabled } from "@/lib/memory-v2";
import { runConsolidation } from "@/lib/memory-consolidation";

/**
 * On-demand consolidation (Phase 2, decision D3). Client idle-triggered:
 * the browser calls this when the app goes idle/hidden for a few minutes.
 * Server side also triggers from /api/chat after N new messages.
 * Idempotent + single-flight leased; failed runs change nothing visible.
 */
export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  if (!memoryConsolidationEnabled()) {
    return NextResponse.json({ ok: false, enabled: false }, { status: 503 });
  }
  try {
    const supabase = getSupabaseAdmin();
    const stats = await runConsolidation(supabase);
    if (!stats.ok && stats.reason === "lease-held") {
      return NextResponse.json({ ok: false, running: true }, { status: 409 });
    }
    return NextResponse.json({ ok: stats.ok, stats });
  } catch {
    console.warn("Consolidation route unavailable", { code: "MEMORY_CONSOLIDATION_FAILED" });
    return NextResponse.json({ ok: false, error: "Consolidation database is not ready" }, { status: 503 });
  }
}
