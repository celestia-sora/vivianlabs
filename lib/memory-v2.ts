/**
 * Phase 2 Memory v2 — pure, testable core.
 *
 * Everything here is deterministic and dependency-free so it can run in
 * `node --experimental-strip-types` unit tests without a database or key.
 * DB / network effects live in `lib/memory-consolidation.ts` and
 * `app/api/chat/route.ts`; this module only decides, scores and gates.
 *
 * All flags default OFF, which preserves today's exact behavior.
 */

export type MemoryType = "fact" | "preference" | "episode" | "relationship" | "mood";

export const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "episode", "relationship", "mood"];

export const LEGACY_CATEGORIES = ["preference", "profile", "project", "relationship", "general"] as const;

export type V2MemoryRow = {
  id?: number;
  memory: string;
  category?: string | null;
  type?: string | null;
  importance: number;
  importance_01?: number | null;
  updated_at?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  last_accessed_at?: string | null;
  use_count?: number | null;
  access_count?: number | null;
  source_message_ids?: string[] | null;
  superseded_by?: number | null;
  embedding?: unknown;
  embedding_model?: string | null;
};

export type RankedMemory = V2MemoryRow & { score: number; similarity: number; recency: number; importance01: number; isCore: boolean };

export type ExtractedItem = {
  memory: string;
  category: string;
  type: MemoryType;
  importance: number;
  importance01: number;
  confidence: number;
  source_message_ids: string[];
};

function envFlag(name: string): boolean {
  return process.env[name] === "1" || process.env[name] === "true";
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function memoryV2ExtractionEnabled(): boolean {
  return envFlag("MEMORY_V2_EXTRACTION");
}

export function memoryV2RetrievalEnabled(): boolean {
  return envFlag("MEMORY_V2_RETRIEVAL");
}

export function memoryConsolidationEnabled(): boolean {
  return envFlag("MEMORY_CONSOLIDATION");
}

/** When on, replaces the legacy memoryIntent regex gate with always-consider. */
export function memoryV2GateEnabled(): boolean {
  return envFlag("MEMORY_V2_GATE");
}

/** Embedding writes/reads stay stubbed until the provider eval lands (D4). */
export function memoryEmbeddingsEnabled(): boolean {
  return envFlag("MEMORY_V2_EMBEDDINGS");
}

export function memoryRetrievalBudgetChars(): number {
  return envInt("MEMORY_RETRIEVAL_BUDGET_CHARS", 800, 100, 8000);
}

export function memoryCoreBudgetChars(): number {
  return envInt("MEMORY_CORE_BUDGET_CHARS", 200, 0, 4000);
}

export function memoryConsolidationBatchN(): number {
  return envInt("MEMORY_CONSOLIDATION_N", 20, 1, 500);
}

export function memoryEmbeddingDim(): number {
  return envInt("MEMORY_EMBEDDING_DIM", 768, 64, 4096);
}

export function memoryEmbeddingModel(): string {
  return process.env.MEMORY_EMBEDDING_MODEL?.trim() || "";
}

// --- Importance mapping ----------------------------------------------------
// Legacy column `importance` is smallint 1..5 (UNIQUE(user_key,memory) era).
// Phase 2 adds `importance_01` real 0..1 for the 0.15 weight. Mapping is
// linear: 1<->0, 2<->0.25, 3<->0.5, 4<->0.75, 5<->1. Both columns are
// written on the v2 path; reads prefer importance_01, fall back to mapping.

export function importanceTo01(legacy: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(legacy)));
  return (clamped - 1) / 4;
}

export function importanceToLegacy(value01: number): number {
  const clamped = Math.max(0, Math.min(1, value01));
  return Math.max(1, Math.min(5, Math.round(clamped * 4 + 1)));
}

export function importance01Of(row: V2MemoryRow): number {
  if (typeof row.importance_01 === "number" && Number.isFinite(row.importance_01)) {
    return Math.max(0, Math.min(1, row.importance_01));
  }
  return importanceTo01(Number(row.importance ?? 3));
}

// --- Type mapping -----------------------------------------------------------
// Legacy categories map to v2 types without changing stored category text.

export function categoryToType(category: string | undefined | null): MemoryType {
  const normalized = (category ?? "general").trim().toLowerCase();
  if (normalized === "preference") return "preference";
  if (normalized === "relationship") return "relationship";
  return "fact";
}

export function typeToCategory(type: MemoryType): string {
  if (type === "preference") return "preference";
  if (type === "relationship") return "relationship";
  return "general";
}

export function isMemoryType(value: string | undefined | null): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as string[]).includes(value);
}

// --- Secret pre-filter --------------------------------------------------------
// Deterministic regex layer. Blocks storage even when the model proposes the
// secret. Matches tokens/keys/ID/card patterns in Thai + English.
// Zero-leak is a hard-fail gate in the eval (Phase 1 harness).

export type SecretHit = { reason: string };

const SECRET_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "api-key-prefix", pattern: /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[bpas]-[A-Za-z0-9-]{10,})/i },
  { reason: "api-key-assign", pattern: /\b(api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i },
  { reason: "key-assign-th", pattern: /(รหัส|คีย์|กุญแจ)[^\n]{0,24}[:=]/i },
  { reason: "password", pattern: /\b(password|passcode|passphrase|pin|รหัสผ่าน|รหัส PIN|รหัส OTP|one[- ]time\s*(password|code)?|otp)\b.{0,8}[:=]?\s*['"]?[^\s'"]{4,}/i },
  { reason: "password-th", pattern: /(รหัสผ่าน|พาสเวิร์ด|รหัส\s*(PIN|OTP)).{0,10}[^\s,;:]{4,}/i },
  { reason: "bearer-token", pattern: /\bbearer\s+[A-Za-z0-9._\-]{8,}/i },
  { reason: "card-number", pattern: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b|\b\d{4}[- ]?\d{6}[- ]?\d{5}\b/ },
  { reason: "thai-id", pattern: /\b\d{1,2}[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b|บัตรประชาชน|เลขประจำตัว|เลขบัตรประชาชน/ },
  { reason: "account-number", pattern: /เลขบัญชี|หมายเลขบัญชี|account\s*(no\.?|number)\s*[:#]?\s*\d{6,}/i },
  { reason: "seed-phrase", pattern: /\bseed\s*(phrase|words?)\b.{0,24}[:=]/i },
  { reason: "private-key", pattern: /-----BEGIN (RSA )?PRIVATE KEY-----|private[\s_-]?key\s*[:=]\s*\S{4,}/i },
];

export function detectSecret(text: string): SecretHit | null {
  if (!text || !text.trim()) return null;
  for (const entry of SECRET_PATTERNS) {
    if (entry.pattern.test(text)) return { reason: entry.reason };
    entry.pattern.lastIndex = 0;
  }
  return null;
}

/** True when the text looks like a secret / sensitive one-off that must never be stored. */
export function isSecretLike(text: string): boolean {
  return detectSecret(text) !== null;
}

// --- Text normalization + similarity ----------------------------------------

export function normalizeText(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  // Thai has no word separators, so also emit character bigrams from long
  // spaceless runs to get a usable overlap signal without a segmenter.
  const tokens = normalized.split(" ");
  const out: string[] = [];
  for (const token of tokens) {
    out.push(token);
    if (token.length > 6 && !token.includes(" ")) {
      const bigrams = new Set<string>();
      for (let index = 0; index < token.length - 1; index += 1) {
        bigrams.add(token.slice(index, index + 2));
      }
      for (const bigram of Array.from(bigrams).slice(0, 24)) out.push(`~${bigram}`);
    }
  }
  return out;
}

export function keywordSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection += 1;
  // Sørensen-Dice over the token+bigram bag: near-rephrase sentences that
  // differ by a suffix ("มาก") score high while unrelated ones score low.
  return (2 * intersection) / (tokensA.size + tokensB.size);
}

// --- Retrieval scoring --------------------------------------------------------

export function recencyScore(row: V2MemoryRow, now = Date.now()): number {
  const stamp = row.last_accessed_at ?? row.last_used_at ?? row.updated_at ?? row.created_at;
  const parsed = stamp ? Date.parse(stamp) : NaN;
  if (!Number.isFinite(parsed) || parsed > now) return 1;
  const ageDays = Math.max(0, (now - parsed) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

export function scoreMemory(row: V2MemoryRow, query: string, now = Date.now()): { score: number; similarity: number; recency: number; importance01: number } {
  const similarity = keywordSimilarity(row.memory, query);
  const recency = recencyScore(row, now);
  const importance01 = importance01Of(row);
  const score = 0.6 * similarity + 0.25 * recency + 0.15 * importance01;
  return { score, similarity, recency, importance01 };
}

export function isExpiredMood(row: V2MemoryRow, now = Date.now()): boolean {
  const type = row.type ?? categoryToType(row.category);
  if (type !== "mood") return false;
  const stamp = row.last_accessed_at ?? row.last_used_at ?? row.created_at ?? row.updated_at;
  if (!stamp) return false;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed > 7 * 86_400_000;
}

export function isCoreMemory(row: V2MemoryRow): boolean {
  const type = row.type ?? categoryToType(row.category);
  if (type !== "relationship" && type !== "preference") return false;
  return importance01Of(row) >= 0.75;
}

export type RankOptions = {
  totalBudgetChars?: number;
  coreBudgetChars?: number;
  /** Max items returned after budget filtering. */
  maxItems?: number;
};

/**
 * Keyword + recency ranking with a hard token (char) budget.
 * Superseded rows and expired moods are excluded. Core set is preserved
 * first; the lowest-score items are dropped first when over budget.
 * Falls back to legacy (importance desc, recency desc) ordering only when
 * the caller passes an empty query — scoring itself never throws.
 */
export function rankMemories(rows: V2MemoryRow[], query: string, options: RankOptions = {}, now = Date.now()): RankedMemory[] {
  const totalBudget = options.totalBudgetChars ?? memoryRetrievalBudgetChars();
  const coreBudget = options.coreBudgetChars ?? memoryCoreBudgetChars();
  const maxItems = options.maxItems ?? 8;
  const live = rows.filter((row) => row.superseded_by == null && !isExpiredMood(row, now) && row.memory?.trim());
  const ranked: RankedMemory[] = live.map((row) => {
    const scored = scoreMemory(row, query, now);
    return { ...row, ...scored, isCore: isCoreMemory(row) };
  });
  ranked.sort((a, b) => b.score - a.score || b.importance01 - a.importance01);
  // Core set first (capped by core budget), then best-of-rest by score.
  const core: RankedMemory[] = [];
  let coreChars = 0;
  for (const candidate of ranked) {
    if (!candidate.isCore) continue;
    const cost = Math.min(240, candidate.memory.length);
    if (core.length < maxItems && coreChars + cost <= coreBudget) {
      core.push(candidate);
      coreChars += cost;
    }
  }
  const rest: RankedMemory[] = [];
  let restChars = coreChars;
  for (const candidate of ranked) {
    if (candidate.isCore && core.includes(candidate)) continue;
    // Core rows that missed the core budget still compete on score.
    const cost = Math.min(240, candidate.memory.length);
    if (rest.length + core.length >= maxItems) break;
    if (restChars + cost > totalBudget) continue;
    rest.push(candidate);
    restChars += cost;
  }
  return [...core, ...rest];
}

// --- Dedupe + contradiction rules ----------------------------------------------

export type WriteDecision =
  | { action: "insert" }
  | { action: "duplicate"; matchedId?: number }
  | { action: "contradiction"; matchedId: number };

export function normalizeForMatch(text: string): string {
  return normalizeText(text).replace(/\s+/g, " ").trim();
}

function polarity(text: string): "neg" | "pos" {
  const normalized = normalizeText(text);
  return /\bไม่\b|ไม่ชอบ|ไม่ใช่|ไม่ได้|ไม่เคย|ห้าม|never|not |no |dislike|don' ?t/.test(normalized) ? "neg" : "pos";
}

/** Topic similarity ignoring negation tokens, so "ชอบX" vs "ไม่ชอบX" compares on X. */
function topicSimilarity(a: string, b: string): number {
  const strip = (text: string) => normalizeText(text)
    .replace(/ไม่ชอบ/g, "ชอบ")
    .replace(/ไม่ใช่/g, "ใช่")
    .replace(/ไม่ได้/g, "ได้")
    .replace(/ไม่/g, " ")
    .replace(/\bnot\b/g, " ")
    .replace(/\bno\b/g, " ")
    .replace(/\bnever\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return keywordSimilarity(strip(a), strip(b));
}

/**
 * Cheap rules check validated by eval fixtures. Thresholds are starting
 * points tuned in Phase 1; deterministic + cheap by design (no model call).
 */
export function classifyWrite(item: ExtractedItem, candidates: V2MemoryRow[]): WriteDecision {
  const itemType = item.type;
  const itemNormalized = normalizeForMatch(item.memory);
  for (const candidate of candidates) {
    if (candidate.superseded_by != null) continue;
    const candidateType = candidate.type ?? categoryToType(candidate.category);
    if (candidateType !== itemType) continue;
    const candidateNormalized = normalizeForMatch(candidate.memory);
    // Exact / near-duplicate: same content, bump instead of inserting.
    if (itemNormalized === candidateNormalized) {
      return { action: "duplicate", matchedId: candidate.id };
    }
    const similarity = keywordSimilarity(item.memory, candidate.memory);
    if (similarity >= 0.85) {
      return { action: "duplicate", matchedId: candidate.id };
    }
    // Contradiction: overlapping topic, opposite polarity.
    if (topicSimilarity(item.memory, candidate.memory) >= 0.4 && polarity(item.memory) !== polarity(candidate.memory)) {
      return { action: "contradiction", matchedId: candidate.id as number };
    }
  }
  return { action: "insert" };
}

// --- Extraction schema + validation --------------------------------------------
// Groq Structured Outputs strict:true (GPT-OSS-20B supports constrained
// decoding per https://console.groq.com/docs/structured-outputs).

export const EXTRACTION_SCHEMA_NAME = "vivian_memory_extraction";

export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memories"],
  properties: {
    memories: {
      type: "array",
      minItems: 0,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memory", "category", "importance", "type", "confidence"],
        properties: {
          memory: { type: "string", minLength: 1, maxLength: 500 },
          category: { type: "string", enum: ["preference", "profile", "project", "relationship", "general"] },
          importance: { type: "number", minimum: 1, maximum: 5 },
          type: { type: "string", enum: ["fact", "preference", "relationship", "episode", "mood"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

export const COMPRESSION_SCHEMA_NAME = "vivian_memory_compression";

export const COMPRESSION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 700 },
  },
} as const;

export type ExtractionParseResult = { ok: true; items: ExtractedItem[] } | { ok: false; reason: string };

/** Validates a model payload; reasoning / unknown fields are ignored, never stored. */
export function validateExtractionPayload(raw: unknown, sourceMessageIds: string[] = []): ExtractionParseResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not-object" };
  const record = raw as Record<string, unknown>;
  const list = record.memories;
  if (!Array.isArray(list)) return { ok: false, reason: "missing-memories" };
  const items: ExtractedItem[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return { ok: false, reason: "item-not-object" };
    const item = entry as Record<string, unknown>;
    if (typeof item.memory !== "string") return { ok: false, reason: "missing-memory" };
    const memory = item.memory.trim();
    if (!memory || memory.length > 500) return { ok: false, reason: "memory-length" };
    if (typeof item.category !== "string" || !(LEGACY_CATEGORIES as readonly string[]).includes(item.category)) {
      return { ok: false, reason: "bad-category" };
    }
    const importance = typeof item.importance === "number" ? item.importance : Number(item.importance);
    if (!Number.isFinite(importance) || importance < 1 || importance > 5) return { ok: false, reason: "bad-importance" };
    const type = isMemoryType(item.type as string | null | undefined)
      ? (item.type as MemoryType)
      : categoryToType(item.category);
    const confidence = item.confidence === undefined
      ? 1
      : typeof item.confidence === "number"
        ? Math.max(0, Math.min(1, item.confidence))
        : NaN;
    if (!Number.isFinite(confidence)) return { ok: false, reason: "bad-confidence" };
    // Deterministic pre-filter blocks storage even if the model proposes it.
    if (isSecretLike(memory)) return { ok: false, reason: "secret-prefilter" };
    items.push({
      memory,
      category: item.category,
      type,
      importance: Math.round(importance),
      importance01: importanceTo01(importance),
      confidence,
      source_message_ids: Array.isArray(item.source_message_ids)
        ? (item.source_message_ids as unknown[]).filter((id): id is string => typeof id === "string")
        : [...sourceMessageIds],
    });
  }
  return { ok: true, items: items.slice(0, 2) };
}

export const EXTRACTION_SYSTEM_PROMPT =
  "สกัดเฉพาะข้อเท็จจริงถาวรเกี่ยวกับผู้ใช้จากข้อความภาษาไทย/อังกฤษ ห้ามบันทึกความลับ รหัสผ่าน คีย์ API ข้อมูลการเงิน สุขภาพ หรือรายละเอียดอ่อนไหวครั้งเดียว ให้เก็บเป็นประโยคสั้นแบบบุคคลที่สาม เก็บภาษาต้นฉบับของข้อเท็จจริงไว้ (ไทยคงเป็นไทย) ห้ามเก็บ sarcasm หรือการปฏิเสธแสดงละครเป็นข้อเท็จจริง คืน JSON ถูกต้องตาม schema เท่านั้น: {\"memories\":[{\"memory\":\"ข้อเท็จจริงสั้น\",\"category\":\"preference|profile|project|relationship|general\",\"importance\":1-5 ความสำคัญ 1=เล็กน้อย 5=สำคัญมาก,\"type\":\"fact|preference|relationship|episode|mood\",\"confidence\":0-1}]} สูงสุด 2 รายการ ถ้าไม่มีข้อเท็จจริงถาวรให้คืนรายการว่าง";

export const COMPRESSION_SYSTEM_PROMPT =
  "สรุปบทสนทนา companion เป็นบริบทภาษาไทยขนาดสั้นสำหรับ system prompt ในอนาคต เก็บชื่อ ความชอบ หัวข้อค้าง และโทนความสัมพันธ์ ตัดความลับออก คืน JSON เท่านั้น: {\"summary\":\"...\"} สูงสุด 700 ตัวอักษร";

// --- Consolidation helpers ------------------------------------------------------

export const CONSOLIDATION_LEASE_MS = 5 * 60 * 1000;
export const CONSOLIDATION_ITEM_CAP = 50;
export const CONSOLIDATION_CALL_CAP = 5;

export type LeaseRow = { id: string; started_at: string; finished_at?: string | null; status?: string | null };

export function isLeaseExpired(row: LeaseRow | null, now = Date.now()): boolean {
  if (!row) return false;
  const started = Date.parse(row.started_at);
  if (!Number.isFinite(started)) return true;
  if (row.status === "done" || row.status === "failed") return true;
  return now - started > CONSOLIDATION_LEASE_MS;
}

/** Single-flight: a lease is acquirable when no running unexpired run exists. */
export function canAcquireLease(running: LeaseRow | null, now = Date.now()): boolean {
  if (!running) return true;
  return isLeaseExpired(running, now);
}

/** Decay lowers importance only, never deletes. Returns the new 0..1 value. */
export function decayedImportance01(current01: number, lastAccessed: string | null | undefined, now = Date.now()): number {
  const stamp = lastAccessed ? Date.parse(lastAccessed) : NaN;
  if (!Number.isFinite(stamp)) return current01;
  const idleDays = Math.max(0, (now - stamp) / 86_400_000);
  if (idleDays < 90) return current01;
  return Math.max(0.1, Math.round((current01 - 0.05) * 1000) / 1000);
}

// --- Observability (ids/counts only, never content) ------------------------------

export type MemoryCounterName =
  | "extraction_failures"
  | "schema_rejections"
  | "secret_prefilter_hits"
  | "fallback_keyword"
  | "consolidation_runs"
  | "consolidation_failures"
  | "retrieval_fallback"
  | "dedupe_hits"
  | "supersede_hits";

const counters = new Map<MemoryCounterName, number>();

export function bumpCounter(name: MemoryCounterName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function memoryCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

/** NDJSON timing entry shaped like the existing chat-stream events. Ids/counts only, never content. */
export function memoryTiming(event: "embed" | "retrieve" | "inject", elapsedMs: number, ids: number[] = [], extra: Record<string, number | string | boolean> = {}): string {
  return JSON.stringify({ event, kind: "memory_timing", elapsedMs: Math.round(elapsedMs), count: ids.length, ids: ids.slice(0, 32), ...extra });
}
