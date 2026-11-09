import assert from "node:assert/strict";
import test from "node:test";
import {
  recallMemories,
  retrieveMemories,
  renderMemoryBlock,
  whenPhrase,
  cosineSimilarity,
  gramSimilarity,
} from "../lib/memory-recall.ts";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();

const item = (overrides = {}) => ({
  id: 1,
  memory: "ผู้ใช้ชอบชาเขียว",
  category: "preference",
  importance: 3,
  updated_at: daysAgo(1),
  use_count: 0,
  ...overrides,
});

test("BM25 ranks a relevant fact above fresh-but-irrelevant ones", () => {
  const items = [
    item({ id: 1, memory: "ผู้ใช้ชอบชาเขียวเย็น", updated_at: daysAgo(10), importance: 1 }),
    item({ id: 2, memory: "โซระจังไปเดินห้างเมื่อวาน", updated_at: daysAgo(0), importance: 5 }),
  ];
  const { ranked, mode } = recallMemories(items, "ชาเขียว", { now: NOW });
  assert.equal(ranked[0].id, 1);
  assert.equal(mode, "BM25");
});

test("superseeded facts never rank and their quote is rendered as evidence", () => {
  const items = [
    item({ id: 9, memory: "ผู้ใช้ชอบกาแฟ", updated_at: daysAgo(20), superseded: true }),
    item({ id: 10, memory: "ภายหลังผู้ใช้บอกว่าไม่ชอบกาแฟแล้ว ชอบชาแทน", updated_at: daysAgo(1), supersedesId: 9 }),
  ];
  const result = retrieveMemories(items, "กาแฟ", { now: NOW });
  assert.ok(!result.selectedIds.includes(9));
  assert.match(result.text, /ภายหลังบอกว่า/);
  assert.match(result.text, /เดิมเคยพูดว่า "ผู้ใช้ชอบกาแฟ"/);
});

test("facts already in the recent window are excluded (OpenAmika exclusion)", () => {
  const items = [
    item({ id: 1, memory: "ผู้ใช้ชอบชาเขียวเย็น" }),
    item({ id: 2, memory: "โซระจังไปคาเฟ่มา" }),
  ];
  const { ranked, excludedIds, mode } = recallMemories(items, "ชาเขียว", {
    now: NOW,
    recentTexts: ["ผู้ใช้ชอบชาเขียวเย็นมาก ๆ เลย"],
  });
  assert.ok(!ranked.some((r) => r.id === 1));
  assert.deepEqual(excludedIds, [1]);
  assert.equal(mode, "BM25");
});

test("vector cosine fuses into the ranking (BM25+vector_RRF)", () => {
  // Paraphrase query with no shared grams: only the vector signal can rank.
  const qv = [1, 0, 0];
  const items = [
    item({ id: 1, memory: "ผู้ใช้ชอบชาเขียวเย็น", embedding: [1, 0, 0] }),
    item({ id: 2, memory: "ผู้ใช้ชอบกาแฟร้อน", embedding: [0, 1, 0] }),
  ];
  const { ranked, mode } = recallMemories(items, "เครื่องดื่มสีเขียวที่ฉันดื่มบ่อย ๆ", { now: NOW, queryEmbedding: qv });
  assert.equal(mode, "BM25+vector_RRF");
  assert.equal(ranked[0].id, 1); // semantic neighbour wins over BM25 silence
});

test("packets pack into the char budget without truncating mid-claim", () => {
  const items = [
    item({ id: 1, memory: "ส".repeat(250) }), // fits the 300-char line cap, needs ~250 chars
    item({ id: 2, memory: "ผู้ใช้ชอบชาเขียว" }),
  ];
  const result = retrieveMemories(items, "ชาเขียว", { now: NOW, budget: 100 });
  assert.ok(result.text.length <= 100 || result.text === "", `budget exceeded: ${result.text.length}`);
  // The oversized packet is skipped whole, not sliced mid-word.
  assert.ok(!result.text.includes("ส".repeat(50)) || result.text === "");
});

test("relative time is rendered as a natural phrase, never a raw date", () => {
  assert.equal(whenPhrase(daysAgo(3), NOW), null);
  assert.equal(whenPhrase(daysAgo(10), NOW), "เมื่อ 10 วันก่อน");
  assert.equal(whenPhrase(daysAgo(45), NOW), "เมื่อ 2 เดือนก่อน");
  const result = retrieveMemories([item({ updated_at: daysAgo(10) })], "ชาเขียว", { now: NOW });
  assert.match(result.text, /\(เมื่อ 10 วันก่อน\)/);
  assert.doesNotMatch(result.text, /\d{4}-\d{2}-\d{2}/);
});

test("rendering has no machine syntax (no ids, no category brackets)", () => {
  const result = retrieveMemories([item({ category: "preference" })], "ชาเขียว", { now: NOW });
  assert.doesNotMatch(result.text, /\[id|\[preference\]/);
  assert.doesNotMatch(result.text, /🔎|vector|BM25/);
  assert.ok(result.text.startsWith("\n\nความทรงจำเกี่ยวกับโซระจังที่ควรรู้:"));
});

test("gram similarity and cosine behave at the correction thresholds", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);
  assert.ok(gramSimilarity("ผู้ใช้ชอบชาเขียว", "ผู้ใช้ชอบชาเขียว") === 1);
  assert.ok(gramSimilarity("ผู้ใช้ชอบชาเขียว", "ผู้ใช้ไม่ชอบกาแฟเลย") < 0.3);
});

test("importance and engagement decay survive when there is no query signal", () => {
  const items = [
    item({ id: 1, memory: "เรื่องเก่า", importance: 5, updated_at: daysAgo(60) }),
    item({ id: 2, memory: "เรื่องใหม่", importance: 1, updated_at: daysAgo(0), use_count: 9 }),
  ];
  const { ranked } = recallMemories(items, "เรื่องที่ไม่ตรงสักตัว", { now: NOW });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((r) => typeof r.score === "number"));
});

test("an empty candidate list renders no block at all", () => {
  assert.deepEqual(retrieveMemories([], "ชาเขียว", { now: NOW }).text, "");
  assert.deepEqual(retrieveMemories([item()], "ชาเขียว", { now: NOW, budget: 0 }).text, "");
});
