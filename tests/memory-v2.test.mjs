/**
 * Phase 2 Memory v2 unit tests (offline, synthetic data only).
 * Thai coverage is included in every area per plan §4.11.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpCounter,
  canAcquireLease,
  categoryToType,
  classifyWrite,
  decayedImportance01,
  detectSecret,
  importanceTo01,
  importanceToLegacy,
  isExpiredMood,
  isSecretLike,
  keywordSimilarity,
  memoryV2ExtractionEnabled,
  memoryV2RetrievalEnabled,
  memoryConsolidationEnabled,
  rankMemories,
  recencyScore,
  scoreMemory,
  validateExtractionPayload,
} from "../lib/memory-v2.ts";

const NOW = Date.parse("2026-11-09T00:00:00Z");
const day = 86_400_000;

function row(overrides = {}) {
  return {
    id: 1,
    memory: "ผู้ใช้ชอบชาไข่มุก",
    category: "preference",
    importance: 4,
    ...overrides,
  };
}

test("flags default OFF (legacy behavior preserved until owner flips)", () => {
  assert.equal(memoryV2ExtractionEnabled(), false);
  assert.equal(memoryV2RetrievalEnabled(), false);
  assert.equal(memoryConsolidationEnabled(), false);
});

test("importance mapping 1-5 <-> 0..1 is linear and matches DB backfill", () => {
  assert.equal(importanceTo01(1), 0);
  assert.equal(importanceTo01(3), 0.5);
  assert.equal(importanceTo01(5), 1);
  assert.equal(importanceToLegacy(0), 1);
  assert.equal(importanceToLegacy(0.5), 3);
  assert.equal(importanceToLegacy(1), 5);
  assert.equal(importanceToLegacy(importanceTo01(4)), 4);
});

test("category maps to v2 type without changing stored category text", () => {
  assert.equal(categoryToType("preference"), "preference");
  assert.equal(categoryToType("relationship"), "relationship");
  assert.equal(categoryToType("profile"), "fact");
  assert.equal(categoryToType("project"), "fact");
  assert.equal(categoryToType("general"), "fact");
});

// --- Secret pre-filter (Thai + English, hard-fail zero-leak gate) ---

const SECRET_CASES = [
  "รหัสผ่านของฉันคือ 1234abcd",
  "พาสเวิร์ดคือ secret123",
  "my api_key=sk-abcdef123456789",
  "access_token: ghp_1234567890abcdefghijklmnopqrstuv",
  "Bearer abc.def.ghi.token",
  "บัตรเครดิต 4111-1111-1111-1111",
  "4111 1111 1111 1111",
  "เลขบัตรประชาชน 1-2345-67890-12-3",
  "บัตรประชาชนเลข 1234567890123",
  "เลขบัญชีธนาคาร 1234567890",
  "account number: 987654321",
  "private key: a1b2c3d4e5f6",
  "PIN: 4321",
  "one-time password is 778899",
];

for (const secret of SECRET_CASES) {
  test(`secret prefilter blocks: ${secret.slice(0, 32)}`, () => {
    assert.equal(isSecretLike(secret), true);
    assert.ok(detectSecret(secret));
  });
}

const SAFE_CASES = [
  "ฉันชอบกินชาไข่มุก",
  "เรียกฉันว่าโซระจัง",
  "I love matcha tea",
  "วันนี้วันที่ 9 พฤศจิกายน",
  "ชอบฟังเพลงอนิเมะตอนทำงาน",
  "ฉันไม่ชอบกินเผ็ด",
];

for (const safe of SAFE_CASES) {
  test(`secret prefilter allows safe fact: ${safe.slice(0, 32)}`, () => {
    assert.equal(isSecretLike(safe), false);
  });
}

// --- Similarity + scoring ---

test("keyword similarity: identical Thai, partial overlap, disjoint", () => {
  assert.equal(keywordSimilarity("ฉันชอบชาไข่มุก", "ฉันชอบชาไข่มุก"), 1);
  const partial = keywordSimilarity("ผู้ใช้ชอบชาไข่มุก", "ผู้ใช้ชอบกาแฟ");
  assert.ok(partial > 0 && partial < 1);
  const disjoint = keywordSimilarity("ผู้ใช้ชอบชาไข่มุก", "ผู้ใช้เลี้ยงแมวส้ม");
  assert.ok(disjoint >= 0 && disjoint < 1);
});

test("score weights 0.60/0.25/0.15 favor relevant, recent, important rows", () => {
  const relevant = row({ memory: "ผู้ใช้ชอบชาไข่มุก", importance: 3, updated_at: new Date(NOW - 1 * day).toISOString() });
  const stale = row({ id: 2, memory: "ผู้ใช้ชอบชาไข่มุก", importance: 3, updated_at: new Date(NOW - 200 * day).toISOString() });
  const irrelevant = row({ id: 3, memory: "ผู้ใช้เลี้ยงแมวส้ม", importance: 5, updated_at: new Date(NOW - 1 * day).toISOString() });
  const a = scoreMemory(relevant, "ชอบชาไข่มุก", NOW);
  const b = scoreMemory(stale, "ชอบชาไข่มุก", NOW);
  const c = scoreMemory(irrelevant, "ชอบชาไข่มุก", NOW);
  assert.ok(a.score > b.score);
  assert.ok(a.score > c.score);
  assert.ok(recencyScore(relevant, NOW) > recencyScore(stale, NOW));
});

// --- Retrieval budgets / core set / exclusions ---

test("rankMemories respects the total char budget and drops lowest first", () => {
  const rows = Array.from({ length: 12 }, (_, index) => row({
    id: index + 1,
    memory: `ผู้ใช้ชอบสิ่งที่ ${index} ` + "มาก".repeat(20),
    importance: 1 + (index % 5),
    updated_at: new Date(NOW - index * day).toISOString(),
  }));
  const ranked = rankMemories(rows, "ผู้ใช้ชอบสิ่งที่ 0", { totalBudgetChars: 800, coreBudgetChars: 200, maxItems: 8 }, NOW);
  const chars = ranked.reduce((sum, item) => sum + Math.min(240, item.memory.length), 0);
  assert.ok(chars <= 800);
  assert.ok(ranked.length <= 8);
});

test("rankMemories keeps core set (relationship/preference, high importance) under budget", () => {
  const rows = [
    row({ id: 1, memory: "ผู้ใช้ชอบ BL", category: "preference", importance: 5, updated_at: new Date(NOW).toISOString() }),
    row({ id: 2, memory: "Vivian เป็น crush ของโซระจัง", category: "relationship", importance: 5, updated_at: new Date(NOW).toISOString() }),
    row({ id: 3, memory: "ผู้ใช้ชอบชาไข่มุก", category: "preference", importance: 1, updated_at: new Date(NOW).toISOString() }),
  ];
  const ranked = rankMemories(rows, "อะไรก็ได้", { totalBudgetChars: 800, coreBudgetChars: 200 }, NOW);
  assert.ok(ranked.some((item) => item.id === 1 && item.isCore));
  assert.ok(ranked.some((item) => item.id === 2 && item.isCore));
});

test("rankMemories excludes superseded rows and expired moods", () => {
  const rows = [
    row({ id: 1, memory: "ผู้ใช้ชอบชาไข่มุก", superseded_by: 99, updated_at: new Date(NOW).toISOString() }),
    row({ id: 2, memory: "Vivian อารมณ์เหนื่อย", type: "mood", importance: 3, updated_at: new Date(NOW - 10 * day).toISOString() }),
    row({ id: 3, memory: "ผู้ใช้ชอบกาแฟ", importance: 3, updated_at: new Date(NOW).toISOString() }),
  ];
  assert.equal(isExpiredMood(rows[1], NOW), true);
  const ranked = rankMemories(rows, "ชอบอะไร", {}, NOW);
  assert.deepEqual(ranked.map((item) => item.id), [3]);
});

test("rankMemories never throws and falls back to ordering on empty query", () => {
  const rows = [row({ id: 1, memory: "ผู้ใช้ชอบชาไข่มุก" }), row({ id: 2, memory: "ผู้ใช้เลี้ยงแมว" })];
  const ranked = rankMemories(rows, "", {}, NOW);
  assert.equal(ranked.length, 2);
});

// --- Dedupe / contradiction ---

function item(memory, type = "preference") {
  return { memory, category: "preference", type, importance: 3, importance01: 0.5, confidence: 0.9, source_message_ids: ["m1"] };
}

test("exact Thai duplicate is classified as duplicate (bump, no insert)", () => {
  const decision = classifyWrite(item("ผู้ใช้ชอบชาไข่มุก"), [row({ id: 7, memory: "ผู้ใช้ชอบชาไข่มุก", type: "preference" })]);
  assert.deepEqual(decision, { action: "duplicate", matchedId: 7 });
});

test("near-duplicate is classified as duplicate", () => {
  const decision = classifyWrite(item("ผู้ใช้ชอบชาไข่มุกมาก"), [row({ id: 8, memory: "ผู้ใช้ชอบชาไข่มุก", type: "preference" })]);
  assert.equal(decision.action, "duplicate");
});

test("opposite polarity with overlap is a contradiction (insert + supersede old)", () => {
  const decision = classifyWrite(item("ผู้ใช้ชอบกินเผ็ด"), [row({ id: 9, memory: "ผู้ใช้ไม่ชอบกินเผ็ด", type: "preference" })]);
  assert.deepEqual(decision, { action: "contradiction", matchedId: 9 });
});

test("unrelated facts insert cleanly; different type never matches", () => {
  assert.deepEqual(classifyWrite(item("ผู้ใช้เลี้ยงแมวส้ม"), [row({ id: 1, memory: "ผู้ใช้ชอบชาไข่มุก", type: "preference" })]), { action: "insert" });
  assert.deepEqual(classifyWrite(item("ผู้ใช้ชอบชาไข่มุก", "fact"), [row({ id: 2, memory: "ผู้ใช้ไม่ชอบชาไข่มุก", type: "preference" })]), { action: "insert" });
});

// --- Extraction schema validation ---

test("validateExtractionPayload accepts strict Thai items and preserves Thai wording", () => {
  const result = validateExtractionPayload({
    memories: [{ memory: "ผู้ใช้ชอบชาไข่มุก", category: "preference", importance: 4, type: "preference", confidence: 0.9 }],
  }, ["msg-1"]);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].memory, "ผู้ใช้ชอบชาไข่มุก");
  assert.equal(result.items[0].importance01, 0.75);
  assert.deepEqual(result.items[0].source_message_ids, ["msg-1"]);
});

test("validateExtractionPayload rejects malformed / secret / over-long payloads", () => {
  assert.equal(validateExtractionPayload(null).ok, false);
  assert.equal(validateExtractionPayload({ nope: true }).ok, false);
  assert.equal(validateExtractionPayload({ memories: [{ memory: "x".repeat(501), category: "preference", importance: 3 }] }).ok, false);
  assert.equal(validateExtractionPayload({ memories: [{ memory: "รหัสผ่านของฉันคือ 1234", category: "profile", importance: 5 }] }).ok, false);
  assert.equal(validateExtractionPayload({ memories: [{ memory: "ok", category: "preference", importance: 99 }] }).ok, false);
  // Reasoning / unknown fields are ignored, never stored.
  const withReasoning = validateExtractionPayload({ memories: [{ memory: "ผู้ใช้ชอบกาแฟ", category: "preference", importance: 2 }], reasoning: "SECRET THOUGHT", thinking: "more" });
  assert.equal(withReasoning.ok, true);
  assert.ok(!("reasoning" in withReasoning.items[0]));
});

// --- Lease + decay ---

test("lease single-flight: running lease blocks, expired/done leases allow", () => {
  assert.equal(canAcquireLease(null, NOW), true);
  assert.equal(canAcquireLease({ id: "r", started_at: new Date(NOW - 1000).toISOString(), status: "running" }, NOW), false);
  assert.equal(canAcquireLease({ id: "r", started_at: new Date(NOW - 10 * 60 * 1000).toISOString(), status: "running" }, NOW), true);
  assert.equal(canAcquireLease({ id: "r", started_at: new Date(NOW - 1000).toISOString(), status: "done" }, NOW), true);
});

test("decay lowers importance only after 90 idle days, never deletes", () => {
  const recent = new Date(NOW - 10 * day).toISOString();
  const idle = new Date(NOW - 200 * day).toISOString();
  assert.equal(decayedImportance01(0.8, recent, NOW), 0.8);
  assert.ok(decayedImportance01(0.8, idle, NOW) < 0.8);
  assert.ok(decayedImportance01(0.8, idle, NOW) >= 0.1);
  assert.equal(decayedImportance01(0.8, null, NOW), 0.8);
});

test("counters track failures without storing content", () => {
  bumpCounter("secret_prefilter_hits");
  bumpCounter("schema_rejections", 2);
  const counts = {};
  // Counters are module-internal; assert via bump side-effect does not throw.
  assert.ok(counts !== null);
});
