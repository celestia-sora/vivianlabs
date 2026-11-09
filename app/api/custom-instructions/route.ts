import { requireApiAccess } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  CUSTOM_INSTRUCTIONS_VERSION_LIMIT,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  normalizeCustomInstructions,
  validCustomInstructions,
} from "@/lib/custom-instructions";

const headers = { "Cache-Control": "private, no-store" };
const columns = "instructions";

function readInstructions(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    // One fixed singleton for all authorized accounts; every device shares it.
    const result = await db.from("vivian_custom_instructions").select(columns).eq("id", "global").maybeSingle();
    if (result.error) throw result.error;
    // Version history is best-effort: if the migration is not applied yet,
    // GET still succeeds with an empty version list (soft-fail, Phase 3).
    let versions: Array<{ id: number; created_at: string; instructions: string }> = [];
    try {
      const v = await db.from("custom_instruction_versions").select("id,created_at,instructions").order("created_at", { ascending: false }).limit(CUSTOM_INSTRUCTIONS_VERSION_LIMIT);
      if (!v.error && Array.isArray(v.data)) {
        versions = v.data.filter((row: { instructions?: unknown }) => typeof row.instructions === "string")
          .map((row: { id: number; created_at: string; instructions: string }) => ({ id: row.id, created_at: row.created_at, instructions: row.instructions }));
      }
    } catch { /* versions table may not exist yet */ }
    return Response.json({ customInstructions: readInstructions(result.data?.instructions), versions }, { headers });
  } catch {
    return Response.json({ error: "Custom instructions are unavailable" }, { status: 503, headers });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid custom instructions" }, { status: 400, headers });
  }
  const record = body as Record<string, unknown>;
  // Single server-side budget: reject oversize with a clear 400, never
  // silently truncate the persona profile (audit W2 fix).
  if (!validCustomInstructions(record.customInstructions)) {
    return Response.json({ error: `customInstructions must be a string of at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters` }, { status: 400, headers });
  }
  const instructions = normalizeCustomInstructions(record.customInstructions);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const result = await db.from("vivian_custom_instructions")
      .upsert({ id: "global", instructions, updated_at: new Date().toISOString() }, { onConflict: "id" })
      .select(columns)
      .single();
    if (result.error) throw result.error;
    // Append a version row on each save (additive, last 10 kept), so a bad
    // persona edit is recoverable. Soft-fail: a missing table must not
    // break the save itself.
    try {
      await db.from("custom_instruction_versions").insert({ instructions });
      const older = await db.from("custom_instruction_versions").select("id").order("created_at", { ascending: false }).range(CUSTOM_INSTRUCTIONS_VERSION_LIMIT, CUSTOM_INSTRUCTIONS_VERSION_LIMIT + 100);
      if (!older.error && Array.isArray(older.data) && older.data.length) {
        const ids = older.data.map((row: { id: number }) => row.id);
        await db.from("custom_instruction_versions").delete().in("id", ids);
      }
    } catch { /* versions table may not exist yet */ }
    return Response.json({ customInstructions: readInstructions(result.data?.instructions) }, { headers });
  } catch {
    return Response.json({ error: "Custom instructions are unavailable" }, { status: 503, headers });
  }
}
