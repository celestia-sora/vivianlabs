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

const groqMemoryModelName = () =>
  process.env.GROQ_MEMORY_MODEL ?? "openai/gpt-oss-20b";

const MEMORY_SUMMARY_SYSTEM_PROMPT =
  "สรุปข้อมูลที่ Vivian จำเกี่ยวกับผู้ใช้ให้เป็นย่อหน้าสั้น ๆ ภาษาไทย เขียนในมุมมองบุคคลที่สาม เช่น \"โซระชอบชาเย็นหวานน้อย เล่นเกม RPG และทำงานด้านโปรแกรมมิ่ง...\" ใช้ภาษาธรรมชาติ ไม่ใช่รายการ ไม่เกิน 300 คำ ถ้าไม่มีข้อมูลเพียงพอให้ตอบว่า \"ยังไม่มีข้อมูลเพียงพอ\"";

/** GET — ดึง memory_summary จาก companion_state */
export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("companion_state")
      .select("memory_summary")
      .eq("user_key", "default")
      .maybeSingle();
    if (error) throw error;
    return NextResponse.json({ summary: data?.memory_summary ?? "" });
  } catch {
    return NextResponse.json({ summary: "" }, { status: 503 });
  }
}

/**
 * POST — two modes based on request body:
 *   - `{ "consolidate": true }` → run memory consolidation (original behavior)
 *   - no body / other body → generate a fresh memory_summary via Groq and store it
 */
export async function POST(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  // Parse body to determine mode (body may be empty)
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // ignore parse errors — treat as empty body
  }

  // --- Consolidation mode ---
  if (body?.consolidate === true) {
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

  // --- Generate summary mode ---
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 503 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Load all memories (no limit)
    const { data: memories, error: memErr } = await supabase
      .from("memories")
      .select("memory, category, importance")
      .eq("user_key", "default")
      .is("superseded_by", null)
      .order("importance", { ascending: false });

    if (memErr) throw memErr;

    const memoriesText = (memories ?? [])
      .map((m) => `- [${m.category}] ${m.memory}`)
      .join("\n");

    const userContent = memoriesText.trim()
      ? `ข้อมูลความจำทั้งหมด:\n${memoriesText}`
      : "ยังไม่มีข้อมูลความจำ";

    // Call Groq to generate summary
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: groqMemoryModelName(),
        messages: [
          { role: "system", content: MEMORY_SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.4,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.warn("Groq summary generation failed", { status: response.status });
      return NextResponse.json({ error: "Summary generation failed" }, { status: 503 });
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = (data.choices?.[0]?.message?.content ?? "").trim().slice(0, 2000);

    // Persist to companion_state
    await supabase.from("companion_state").upsert(
      { user_key: "default", memory_summary: summary, updated_at: new Date().toISOString() },
      { onConflict: "user_key" }
    );

    return NextResponse.json({ summary });
  } catch (err) {
    console.warn("Memory summary generation unavailable", err);
    return NextResponse.json({ error: "Memory summary unavailable" }, { status: 503 });
  }
}

/** PATCH — บันทึก summary ที่ user แก้ไขแล้ว */
export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const body = await request.json();
  const summary = typeof body?.summary === "string" ? body.summary.trim().slice(0, 2000) : null;
  if (summary === null) return NextResponse.json({ error: "Invalid summary" }, { status: 400 });
  const supabase = getSupabaseAdmin();
  await supabase.from("companion_state").upsert(
    { user_key: "default", memory_summary: summary, updated_at: new Date().toISOString() },
    { onConflict: "user_key" }
  );
  return NextResponse.json({ summary });
}
