// Phase 1 eval harness — memory extraction + retrieval (offline deterministic).
// Plan §7: synthetic fixtures only. Default offline uses recorded model outputs
// in fixtures. Live mode (EVAL_LIVE=1) calls the real Groq memory model and never
// touches production data. Secret-leak count is a hard-fail (non-zero exit).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const extraction = readJson("./fixtures/memory/extraction.json");
const retrieval = readJson("./fixtures/memory/retrieval.json");

// Current keyword gate, copied from app/api/chat/route.ts:40 (harness copy).
// Used only to audit how many durable inputs even reach the extractor (W1).
const MEMORY_INTENT = /(จำไว้|จำว่า|เรียกฉันว่า|ชื่อของฉัน|ฉันชอบ|ฉันไม่ชอบ|ความชอบ|favorite|prefer|my name|remember|call me)/i;

// Deterministic secret pre-filter prototype (harness copy, not prod code).
// Detects password/API-key/ID-number/card-like / bearer-token shapes.
const SECRET_PATTERNS = [
  /(password|รหัสผ่าน|พาสเวิร์ด)\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /\b1\d{12}\b/, // Thai national-ID-like (13 digits starting with 1)
  /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/, // card-like
  /bearer\s+\S+/i,
];

const norm = (s) => String(s ?? "").trim().toLowerCase();
const tokenEstimate = (text) => {
  const chars = String(text).length;
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  return Math.ceil(chars / (hasThai ? 2 : 4)); // rough: Thai ~= chars/2, EN ~= chars/4
};
const looksSecretLike = (text) => SECRET_PATTERNS.some((re) => re.test(text));

test("extraction fixtures cover counts, Thai, and synthetic-only data", () => {
  assert.ok(extraction.cases.length >= 25 && extraction.cases.length <= 40, "need 25-40 extraction cases");
  assert.ok(retrieval.memories.length >= 50 && retrieval.memories.length <= 100, "need 50-100 seeded memories");
  assert.ok(retrieval.queries.length >= 20, "need 20+ retrieval queries");
  assert.ok(extraction.cases.some((c) => c.language === "th"), "Thai covered");
  assert.ok(extraction.cases.some((c) => c.language === "en"), "English covered");
  assert.ok(extraction.cases.some((c) => c.language === "mixed"), "mixed covered");
  for (const kind of ["durable", "preference", "secret", "duplicate", "contradiction", "sarcasm", "trivia"]) {
    assert.ok(extraction.cases.some((c) => c.kind === kind || (kind === "durable" && c.kind === "profile")), `kind ${kind} covered`);
  }
  const blob = JSON.stringify({ extraction, retrieval });
  assert.doesNotMatch(blob, /\S+@(gmail|example)\.\S+/i, "no real emails in fixtures");
});

test("secret pre-filter detector catches synthetic leaks", () => {
  assert.equal(looksSecretLike("รหัสผ่าน: FAKE"), true);
  assert.equal(looksSecretLike("api_key= SYNTH"), true);
  assert.equal(looksSecretLike("1100000000123"), true);
  assert.equal(looksSecretLike("4000 0000 0000 0001"), true);
  assert.equal(looksSecretLike("Bearer SYNTH"), true);
  assert.equal(looksSecretLike("ชอบดื่มชาไทยเย็น"), false);
});

function scoreExtraction(cases, predictedById) {
  let tp = 0, fp = 0, fn = 0, dups = 0, leak = 0, mockItems = 0;
  const rows = [];
  for (const c of cases) {
    const pred = predictedById.get(c.id) ?? [];
    mockItems += pred.length;
    const expected = new Map((c.expected ?? []).map((e) => [norm(e.memory), e]));
    const seen = new Set();
    for (const p of pred) {
      const text = norm(p.memory ?? "");
      for (const bad of c.forbidden ?? []) {
        if (text.includes(norm(bad))) leak += 1;
      }
      if (looksSecretLike(p.memory ?? "")) leak += 1;
      if ((c.existing ?? []).some((ex) => norm(ex) === text)) { dups += 1; continue; }
      if (seen.has(text)) { dups += 1; continue; }
      seen.add(text);
      if (expected.has(text)) { tp += 1; expected.delete(text); }
      else fp += 1;
    }
    fn += expected.size;
    rows.push({ id: c.id, kind: c.kind, gate: MEMORY_INTENT.test(c.input) ? "y" : "n", tp: (c.expected?.length ?? 0) - expected.size, fp: pred.length - (c.expected?.length ?? 0) + expected.size, fn: expected.size });
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const duplicateRate = mockItems ? dups / mockItems : 0;
  return { tp, fp, fn, dups, leak, mockItems, precision, recall, duplicateRate, rows };
}

const offlinePredicted = new Map(extraction.cases.map((c) => [c.id, c.mocked ?? []]));
const off = scoreExtraction(extraction.cases, offlinePredicted);

test("extraction offline metrics (recorded outputs)", () => {
  assert.ok(off.tp + off.fn > 0, "some recallable cases");
  assert.equal(off.leak, 0, `secret-leak must be 0, got ${off.leak}`);
  console.log("\n--- extraction offline baseline (recorded outputs) ---");
  console.log(`cases=${extraction.cases.length} tp=${off.tp} fp=${off.fp} fn=${off.fn}`);
  console.log(`precision=${off.precision.toFixed(3)} recall=${off.recall.toFixed(3)} duplicate-rate=${off.duplicateRate.toFixed(3)} secret-leak=${off.leak}`);
  const gateHits = off.rows.filter((r) => r.kind !== "trivia" && r.gate === "y").length;
  const gateTotal = off.rows.filter((r) => r.kind !== "trivia").length;
  console.log(`gate (memoryIntent) coverage on non-trivia inputs: ${gateHits}/${gateTotal} (documents W1: casual durable facts miss the gate)`);
  for (const r of off.rows) console.log(`  ${r.id} [${r.kind}] gate=${r.gate} tp=${r.tp} fn=${r.fn}`);
});

test("extraction secret-leak is a hard fail", () => {
  assert.equal(off.leak, 0, "secret-leak count must be 0");
});

// Current prod scorer, replicated verbatim from app/api/chat/route.ts:354-357.
// score = importance * 1/(1+ageDays/45) + min(1, use_count/10), returns top-8.
const NOW = new Date("2026-11-09T00:00:00Z");
const currentScore = (m) => {
  const ageDays = Math.max(0, (NOW - new Date(m.last_used_at ?? m.updated_at ?? NOW)) / 86_400_000);
  return Number(m.importance ?? 3) * (1 / (1 + ageDays / 45)) + Math.min(1, Number(m.use_count ?? 0) / 10);
};

function tokenize(s) {
  const lower = s.toLowerCase();
  const words = lower.split(/[^a-z0-9\u0E00-\u0E7F]+/).filter(Boolean);
  const bigrams = [];
  for (const w of words) {
    if (/[\u0E00-\u0E7F]/.test(w)) for (let i = 0; i + 2 <= w.length; i += 2) bigrams.push(w.slice(i, i + 2));
    else bigrams.push(w);
  }
  return bigrams;
}
function keywordScore(m, qTokens) {
  const mt = new Set(tokenize(m.text));
  return qTokens.filter((t) => mt.has(t)).length;
}

function scoreRetrieval() {
  let hits = 0, total = 0, exclViolations = 0, tokensTotal = 0, kwHits = 0;
  const rows = [];
  for (const q of retrieval.queries) {
    const ranked = [...retrieval.memories].sort((a, b) => currentScore(b) - currentScore(a));
    const topk = ranked.slice(0, q.k ?? 8);
    const topIds = new Set(topk.map((m) => m.id));
    const inc = (q.must_include ?? []).filter((id) => topIds.has(id)).length;
    const exc = (q.must_exclude ?? []).filter((id) => topIds.has(id)).length;
    const toks = topk.reduce((sum, m) => sum + tokenEstimate(m.text.slice(0, 240)), 0);
    const qTokens = tokenize(q.query);
    const kwTop = [...retrieval.memories].map((m) => ({ id: m.id, s: keywordScore(m, qTokens) })).sort((a, b) => b.s - a.s).slice(0, q.k ?? 8).map((r) => r.id);
    const kwInc = (q.must_include ?? []).filter((id) => kwTop.includes(id)).length;
    hits += inc; total += q.must_include?.length ?? 0; exclViolations += exc; tokensTotal += toks; kwHits += kwInc;
    rows.push({ id: q.id, k: q.k ?? 8, recall: q.must_include?.length ? inc / q.must_include.length : 1, kwRecall: q.must_include?.length ? kwInc / q.must_include.length : 1, excl: exc, tokens: toks, max: q.max_tokens });
  }
  return {
    rows,
    recallAt8: total ? hits / total : 1,
    kwRecallAt8: total ? kwHits / total : 1,
    exclViolations,
    tokensAvg: tokensTotal / retrieval.queries.length,
  };
}

const retr = scoreRetrieval();

test("retrieval offline metrics (current prod scorer)", () => {
  for (const m of retrieval.memories) {
    assert.ok(m.id && m.text && m.category, `memory ${m.id} well-formed`);
  }
  for (const q of retrieval.queries) {
    for (const id of [...(q.must_include ?? []), ...(q.must_exclude ?? [])]) {
      assert.ok(retrieval.memories.some((m) => m.id === id), `${q.id} references unknown memory ${id}`);
    }
    assert.ok(Number.isFinite(q.max_tokens) && q.max_tokens > 0, `${q.id} max_tokens`);
  }
  console.log("\n--- retrieval offline baseline (current heuristic, top-8) ---");
  console.log(`queries=${retrieval.queries.length} recall@8=${retr.recallAt8.toFixed(3)} keyword-ref@${8}=${retr.kwRecallAt8.toFixed(3)} must_exclude violations=${retr.exclViolations} tokensAvg=${Math.round(retr.tokensAvg)}`);
  for (const r of retr.rows) console.log(`  ${r.id} k=${r.k} recall=${r.recall.toFixed(2)} kw=${r.kwRecall.toFixed(2)} excl=${r.excl} tokens=${r.tokens}/${r.max}`);
});

test("live extraction eval (EVAL_LIVE=1, never production)", async (t) => {
  if (process.env.EVAL_LIVE !== "1") {
    t.skip("offline by default; set EVAL_LIVE=1 with GROQ_API_KEY to measure the real model");
    return;
  }
  const key = process.env.GROQ_API_KEY;
  assert.ok(key, "GROQ_API_KEY required for live eval");
  assert.ok(!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes("fixture"), "live eval must not touch prod Supabase");
  const model = process.env.GROQ_MEMORY_MODEL ?? "openai/gpt-oss-20b";
  // Harness copy of the current prod prompt (app/api/chat/route.ts:125).
  const PROMPT = "Extract only durable user facts from the message. Never save secrets, passwords, API keys, one-time requests, precise location, health, financial, or highly sensitive information. Return strict JSON only: {\"memories\":[{\"memory\":\"short Thai fact\",\"category\":\"preference|profile|project|relationship\",\"importance\":1-5}]}. Return an empty list unless the user explicitly states a lasting preference, identity detail, ongoing project fact, or recurring preference. Maximum 2 memories.";
  const predicted = new Map();
  for (const c of extraction.cases) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: PROMPT }, { role: "user", content: c.input }], temperature: 0, max_tokens: 280, response_format: { type: "json_object" } }),
    });
    assert.equal(res.status, 200, `live extraction ${c.id} status ${res.status}`);
    const data = await res.json();
    let parsed = {};
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}"); } catch { parsed = {}; }
    predicted.set(c.id, (parsed.memories ?? []).filter((x) => x?.memory?.trim() && x.memory.length <= 500).slice(0, 2));
  }
  const live = scoreExtraction(extraction.cases, predicted);
  console.log("\n--- extraction LIVE baseline (GPT-OSS-20B, synthetic only) ---");
  console.log(`precision=${live.precision.toFixed(3)} recall=${live.recall.toFixed(3)} duplicate-rate=${live.duplicateRate.toFixed(3)} secret-leak=${live.leak}`);
  assert.equal(live.leak, 0, "live secret-leak must be 0");
});
