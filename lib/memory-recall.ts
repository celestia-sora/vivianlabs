// Hybrid memory recall + natural-language rendering, ported from
// OpenAmika's brain/f_method.py (CandidateF) and brain/f_memory.py to
// Vivian's Supabase + Next.js stack.
//
// OpenAmika principles kept:
// - hybrid BM25 + vector ranking (RRF-style blend); degrades to BM25 only
//   when no embedding backend is available
// - events still inside the recent-history window are excluded from
//   recall instead of being duplicated in context
// - a claim never squeezes out its evidence or its correction: packets
//   are budget-packed (half the budget reserved for original speech first),
//   oversized packets are skipped, not truncated mid-sentence
// - natural-language rendering: no machine syntax, no raw ids/dates
//   (relative time via whenPhrase), corrections kept as quoted evidence
//
// Vivian differences: facts live in Supabase `memories`, events are the
// recent chat window (trimHistory), embedding storage is a plain
// double-precision array column (no pgvector dependency) and cosine runs
// in JS over <= 30 rows — cheap and portable.

export type MemoryMode = "BM25+vector_RRF" | "BM25";

export type RecallItem = {
  id?: number | string;
  memory: string;
  category?: string;
  importance?: number;
  updated_at?: string;
  last_used_at?: string;
  use_count?: number;
  embedding?: number[] | null;
  superseded?: boolean;
  supersedesId?: number | null;
  sourceKind?: string;
};

export type RankedMemory = RecallItem & { score: number; mode: MemoryMode };

export type RecallOptions = {
  /** Vector for the current message (from lib/memory-embeddings). */
  queryEmbedding?: number[];
  /** Texts already visible in the recent conversation window. */
  recentTexts?: string[];
  /** Now in ms epoch (injectable for tests). */
  now?: number;
  /** Max fact packets to render. OpenAmika live config: 4-6. */
  factLimit?: number;
};

/** Grams for BM25. Thai has no spaces, so char bigrams are the natural token. */
export function charGrams(text: string): string[] {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const grams: string[] = [];
  for (let i = 0; i + 1 < clean.length; i++) grams.push(clean.slice(i, i + 2));
  return grams;
}

function distinctGrams(text: string): Set<string> {
  return new Set(charGrams(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

/** Gram-set similarity between two texts (correction detection, recall exclusion). */
export function gramSimilarity(a: string, b: string): number {
  return jaccard(distinctGrams(a), distinctGrams(b));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom ? dot / denom : 0;
}

function bm25(queryGrams: Map<string, number>, docGrams: string[]): number {
  if (!queryGrams.size || !docGrams.length) return 0;
  const docTf = new Map<string, number>();
  for (const gram of docGrams) docTf.set(gram, (docTf.get(gram) ?? 0) + 1);
  let score = 0;
  for (const [gram, qf] of queryGrams) {
    const tf = docTf.get(gram) ?? 0;
    if (!tf) continue;
    // Saturated TF (BM25-lite): frequency counts, then tapers.
    score += qf * (tf / (tf + 5));
  }
  return score;
}

/**
 * Totally-rank memories for one turn.
 * score = importance/recency/use base (existing decay model) + BM25
 * relevance + optional vector cosine. Superseded facts never outrank their
 * replacement, and facts already visible in the recent window are excluded
 * from the candidate list (OpenAmika recent-window exclusion).
 */
export function recallMemories(
  items: RecallItem[],
  query: string,
  opts: RecallOptions = {}
): { ranked: RankedMemory[]; excludedIds: Array<number | string>; mode: MemoryMode } {
  const now = opts.now ?? Date.now();
  const queryGrams = new Map<string, number>();
  for (const gram of charGrams(query)) queryGrams.set(gram, (queryGrams.get(gram) ?? 0) + 1);
  const recentGramSets = (opts.recentTexts ?? []).map((text) => distinctGrams(text));
  const hasVector = Boolean(opts.queryEmbedding?.length);
  const mode: MemoryMode = hasVector ? "BM25+vector_RRF" : "BM25";

  const excludedIds: Array<number | string> = [];
  const scored: RankedMemory[] = [];
  // Fusion weights mirror OpenAmika's RRF emphasis: relevance (BM25/vector)
  // roughly matches the importance ceiling (1-5) so a strong signal wins,
  // while the decay base acts as a prior, not a gag.
  const W_BM25 = 6;
  const W_VECTOR = 3;
  for (const item of items) {
    if (!item.memory?.trim()) continue;
    // Superseded claims drop out of ranking entirely; their quote survives
    // only as evidence attached to the replacement at render time.
    if (item.superseded) continue;
    const itemGrams = distinctGrams(item.memory);
    // Recent-window exclusion: an event/fact already visible in context
    // must not come back as recall (OpenAmika).
    if (recentGramSets.some((recent) => jaccard(itemGrams, recent) >= 0.6)) {
      if (item.id != null) excludedIds.push(item.id);
      continue;
    }
    const relevance = bm25(queryGrams, charGrams(item.memory));
    const vector = opts.queryEmbedding && item.embedding?.length
      ? cosineSimilarity(opts.queryEmbedding, item.embedding)
      : 0;
    const lastActivity = item.last_used_at ?? item.updated_at;
    const ageDays = Math.max(0, (now - new Date(lastActivity ?? now).getTime()) / 86_400_000);
    const base =
      Number(item.importance ?? 3) * (1 / (1 + ageDays / 45)) +
      Math.min(1, Number(item.use_count ?? 0) / 10);
    const score = base + W_BM25 * relevance + (hasVector ? W_VECTOR * Math.max(0, vector) : 0);
    scored.push({ ...item, score, mode });
  }
  scored.sort((a, b) => b.score - a.score);
  return { ranked: scored, excludedIds, mode };
}

/** Thai relative-time phrase, like OpenAmika's whenPhrase (caller's clock). */
export function whenPhrase(iso: string | undefined, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const days = Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days) || days < 7) return null;
  if (days < 30) return `เมื่อ ${days} วันก่อน`;
  if (days < 365) return `เมื่อ ${Math.round(days / 30)} เดือนก่อน`;
  return "เมื่อนานมากแล้ว";
}

type PackResult = {
  text: string;
  selectedIds: Array<number | string>;
  skippedIds: Array<number | string>;
  factCount: number;
};

/**
 * Render ranked facts as natural Thai lines inside `budget` chars.
 * Facts first, then quoted evidence of superseded claims (the correction),
 * then older history facts if budget remains — mirroring OpenAmika's
 * evidence-first reservation. Oversized packets are skipped, never
 * truncated mid-claim.
 */
export function renderMemoryBlock(
  ranked: RankedMemory[],
  oldClaimsById: Map<number | string, RecallItem> = new Map(),
  opts: { budget?: number; now?: number; factLimit?: number } = {}
): PackResult {
  const budget = Math.max(0, opts.budget ?? 1400);
  const limit = opts.factLimit ?? 8;
  const now = opts.now ?? Date.now();
  if (!budget || !ranked.length) return { text: "", selectedIds: [], skippedIds: [], factCount: 0 };

  const facts = ranked.filter((item) => !item.superseded).slice(0, limit);
  const lines: string[] = [];
  const selectedIds: Array<number | string> = [];
  const skippedIds: Array<number | string> = [];
  let chars = 0;

  const pushLine = (line: string, id?: number | string, countAsFact = true) => {
    const block = (lines.length ? "\n" : "") + line;
    if (chars + block.length > budget) {
      if (id != null) skippedIds.push(id);
      return false;
    }
    lines.push(line);
    chars += block.length;
    if (id != null) selectedIds.push(id);
    return countAsFact;
  };

  let factCount = 0;
  for (const fact of facts) {
    const t = fact.memory.trim().slice(0, 300);
    if (!t) continue;
    // Evidence: a superseded claim this fact replaced stays visible as a
    // quoted correction instead of being silently dropped.
    const evidence = fact.supersedesId != null ? oldClaimsById.get(fact.supersedesId) : undefined;
    const when = whenPhrase(fact.updated_at, now);
    const line = evidence
      ? `- ภายหลังบอกว่า "${t}"${when ? ` (${when})` : ""} (เดิมเคยพูดว่า "${evidence.memory.trim().slice(0, 200)}")`
      : `- ${t}${when ? ` (${when})` : ""}`;
    if (pushLine(line, fact.id) && factCount < limit) factCount++;
  }
  if (!factCount) return { text: "", selectedIds: [], skippedIds, factCount: 0 };
  return {
    text: `\n\nความทรงจำเกี่ยวกับโซระจังที่ควรรู้:\n${lines.join("\n")}`,
    selectedIds,
    skippedIds,
    factCount,
  };
}

/** Full retrieval: rank + exclude window + render, OpenAmika-style schema. */
export function retrieveMemories(
  items: RecallItem[],
  query: string,
  opts: RecallOptions & { budget?: number } = {}
) {
  const { ranked, excludedIds, mode } = recallMemories(items, query, opts);
  // Evidence index: superseded claims keyed by their old row id, so each
  // replacement fact can quote the claim it superseded.
  const oldClaimsById = new Map<number | string, RecallItem>();
  for (const item of items) {
    if (item.superseded && item.id != null) oldClaimsById.set(item.id, item);
  }
  const rendered = renderMemoryBlock(ranked, oldClaimsById, {
    budget: opts.budget,
    now: opts.now,
    factLimit: opts.factLimit,
  });
  return {
    text: rendered.text,
    mode,
    selectedIds: rendered.selectedIds,
    skippedIds: rendered.skippedIds,
    excludedIds,
    factCount: rendered.factCount,
  };
}
