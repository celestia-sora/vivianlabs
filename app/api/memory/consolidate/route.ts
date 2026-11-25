import { requireAuthorizedUser } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadMemorySummary, saveMemorySummary } from "@/lib/companion-store";
import { memoryConsolidationEnabled } from "@/lib/memory-v2";
import { runConsolidation } from "@/lib/memory-consolidation";
import {
  buildGroqSummaryPayload,
  buildMemorySummaryInput,
  isMissingSupersededColumnError,
  MEMORY_SUMMARY_EMPTY_MESSAGE,
  MEMORY_SUMMARY_SYSTEM_PROMPT,
  sanitizeSummaryText,
  type MemorySummarySourceItem,
} from "@/lib/memory-summary";

/**
 * On-demand consolidation (Phase 2, decision D3). Client idle-triggered:
 * the browser calls this when the app goes idle/hidden for a few minutes.
 * Server side also triggers from /api/chat after N new messages.
 * Idempotent + single-flight leased; failed runs change nothing visible.
 */

const groqMemoryModelName = () =>
  process.env.GROQ_MEMORY_MODEL ?? "openai/gpt-oss-20b";
const groqFallbackModelName = () =>
  process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b";
const geminiSummaryModelName = () => {
  const custom = process.env.GEMINI_MODEL;
  if (custom && !custom.startsWith("gemini-3")) return custom;
  return "gemini-2.5-flash";
};

async function callGroqSummary(apiKey: string, model: string, userContent: string): Promise<{ summary: string; status?: number; finishReason?: string }> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify(buildGroqSummaryPayload(model, userContent)),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.warn("Groq summary generation failed", { model, status: response.status, detail: errText.slice(0, 200) });
    return { summary: "", status: response.status };
  }
  const data = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  };
  const choice = data.choices?.[0];
  const summary = sanitizeSummaryText(choice?.message?.content ?? "");
  if (!summary) {
    console.warn("Groq summary generation returned empty content", { model, finishReason: choice?.finish_reason ?? "unknown" });
  }
  return { summary, status: response.status, finishReason: choice?.finish_reason };
}

async function callGeminiSummary(apiKey: string, userContent: string): Promise<string> {
  const model = geminiSummaryModelName();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: MEMORY_SUMMARY_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1000 },
      }),
    },
  );
  if (!response.ok) {
    console.warn("Gemini summary generation failed", { model, status: response.status });
    return "";
  }
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return sanitizeSummaryText(text);
}

/** GET — ดึง memory_summary จาก companion_state */
export async function GET(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;
  try {
    const supabase = getSupabaseAdmin();
    const summary = await loadMemorySummary(user.id, supabase);
    return NextResponse.json({ summary });
  } catch {
    return NextResponse.json({ summary: "" }, { status: 503 });
  }
}

/**
 * POST — two modes based on request body:
 *   - `{ "consolidate": true }` → run memory consolidation (original behavior)
 *   - no body / other body → generate a fresh memory_summary via Groq (with fallback) and store it
 */
export async function POST(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
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
      const stats = await runConsolidation(supabase, user.id);
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
  const groqApiKey = process.env.GROQ_API_KEY?.trim() ?? "";
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!groqApiKey && !geminiApiKey) {
    return NextResponse.json({ error: "No summary provider configured" }, { status: 503 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Load active memories (bounded for token safety; fall back if superseded_by column is absent)
    let memories: MemorySummarySourceItem[] | null = null;
    const primaryQuery = await supabase
      .from("memories")
      .select("memory, category, importance")
      .eq("user_key", user.id)
      .is("superseded_by", null)
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(100);

    if (primaryQuery.error) {
      if (!isMissingSupersededColumnError(primaryQuery.error)) {
        throw primaryQuery.error;
      }
      const fallbackQuery = await supabase
        .from("memories")
        .select("memory, category, importance")
        .eq("user_key", user.id)
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(100);
      if (fallbackQuery.error) throw fallbackQuery.error;
      memories = (fallbackQuery.data ?? []) as MemorySummarySourceItem[];
    } else {
      memories = (primaryQuery.data ?? []) as MemorySummarySourceItem[];
    }

    const input = buildMemorySummaryInput(memories);
    if (input.count === 0) {
      await saveMemorySummary(user.id, MEMORY_SUMMARY_EMPTY_MESSAGE, supabase);
      return NextResponse.json({ summary: MEMORY_SUMMARY_EMPTY_MESSAGE });
    }

    const userContent = `ข้อมูลความจำทั้งหมด:\n${input.text}`;
    let summary = "";

    if (groqApiKey) {
      const primaryModel = groqMemoryModelName();
      const first = await callGroqSummary(groqApiKey, primaryModel, userContent).catch((err) => {
        console.warn("Groq primary summary request error", err);
        return { summary: "" };
      });
      summary = first.summary;

      const fallbackModel = groqFallbackModelName();
      if (!summary && fallbackModel !== primaryModel) {
        const second = await callGroqSummary(groqApiKey, fallbackModel, userContent).catch((err) => {
          console.warn("Groq fallback summary request error", err);
          return { summary: "" };
        });
        summary = second.summary;
      }
    }

    if (!summary && geminiApiKey) {
      summary = await callGeminiSummary(geminiApiKey, userContent).catch((err) => {
        console.warn("Gemini fallback summary request error", err);
        return "";
      });
    }

    if (!summary) {
      return NextResponse.json({ error: "Summary generation failed" }, { status: 503 });
    }

    // Persist to companion_state
    await saveMemorySummary(user.id, summary, supabase);

    return NextResponse.json({ summary });
  } catch (err) {
    console.warn("Memory summary generation unavailable", err);
    return NextResponse.json({ error: "Memory summary unavailable" }, { status: 503 });
  }
}

/** PATCH — บันทึก summary ที่ user แก้ไขแล้ว */
export async function PATCH(request: Request) {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const summary =
    body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).summary === "string"
      ? ((body as Record<string, unknown>).summary as string).trim().slice(0, 2000)
      : null;
  if (summary === null) return NextResponse.json({ error: "Invalid summary" }, { status: 400 });
  try {
    const supabase = getSupabaseAdmin();
    await saveMemorySummary(user.id, summary, supabase);
    return NextResponse.json({ summary });
  } catch {
    return NextResponse.json({ error: "Memory summary unavailable" }, { status: 503 });
  }
}
