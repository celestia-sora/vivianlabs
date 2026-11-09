import assert from "node:assert/strict";
import test from "node:test";
import { applyConversationTurn, companionPromptBlock, defaultCompanionState, decayCompanionState, normalizeMood, clampScore, sanitizeCompanionState, validateProposedState, affinityBand, trustBand, familiarityBand, moodIntensityBand, boundedDelta, MAX_DELTA_AFFINITY_PER_TURN, MAX_DELTA_MOOD_INTENSITY_PER_TURN } from "../lib/companion.ts";

test("legacy moods migrate without resetting relationship or memory", () => {
  const saved = { ...defaultCompanionState(), affinity: 82, trust: 73, familiarity: 64, mood: "tsundere", conversationSummary: "ผู้ใช้ชอบชา" };
  const restored = { ...saved, mood: normalizeMood(saved.mood) };
  assert.equal(restored.mood, "yandere");
  assert.equal(restored.affinity, saved.affinity);
  assert.equal(restored.trust, saved.trust);
  assert.equal(restored.familiarity, saved.familiarity);
  assert.equal(restored.conversationSummary, saved.conversationSummary);
  assert.equal(normalizeMood("unknown"), "calm");
  assert.equal(normalizeMood("warm"), "warm");
  assert.equal(normalizeMood("yandere"), "yandere");
});

test("a jealous reply expresses yandere mood even in a new relationship", () => {
  const state = defaultCompanionState();
  const next = applyConversationTurn(state, "มีคนมาจีบฉัน", "ใคร? เธอไม่ต้องสนใจคนนั้นหรอก");
  assert.equal(next.mood, "yandere");
  assert.equal(state.mood, "calm");
  assert.equal(next.affinity, state.affinity + 1);
});

test("embarrassment does not replace Vivian's yandere mood", () => {
  const next = applyConversationTurn(defaultCompanionState(), "ชมได้ไหม", "หน้าแดงทำไม? ไม่ได้เขินสักหน่อย");
  assert.equal(next.mood, "yandere");
});

test("distress takes precedence over flustered banter", () => {
  const next = applyConversationTurn(defaultCompanionState(), "วันนี้เศร้ามาก", "ฉันฟังอยู่ ไม่ได้เป็นห่วงสักหน่อย");
  assert.equal(next.mood, "melancholy");
});

test("idle banter does not increase closeness and intense moods still decay", () => {
  const state = { ...defaultCompanionState(), moodIntensity: 98 };
  const next = applyConversationTurn(state, "", "ฉันหวงเธอ", true);
  assert.equal(next.affinity, state.affinity);
  assert.equal(next.familiarity, state.familiarity);
  assert.equal(next.moodIntensity, 100);
  const faded = decayCompanionState(next, Date.parse(next.lastInteractionAt) + 24 * 3_600_000);
  assert.equal(faded.mood, "calm");
  assert.equal(faded.affinity, state.affinity);
});

test("tired and anxious turns get their own moods instead of generic sadness", () => {
  assert.equal(applyConversationTurn(defaultCompanionState(), "วันนี้เหนื่อยมาก", "พักก่อนสิ").mood, "tired");
  assert.equal(applyConversationTurn(defaultCompanionState(), "วันนี้เพลีย อยากนอน", "พักบ้างสิ").mood, "tired");
  assert.equal(applyConversationTurn(defaultCompanionState(), "ฉันกลัวมากเลย", "ฉันอยู่ตรงนี้").mood, "melancholy");
  assert.equal(applyConversationTurn(defaultCompanionState(), "วันนี้เศร้า", "ฉันฟังอยู่").mood, "melancholy");
});

test("relationship prompt gives Vivian initiative without inventing closeness", () => {
  const early = companionPromptBlock(defaultCompanionState());
  assert.match(early, /ยังรู้จักกันไม่นาน: Vivian ยังมีความเห็นและริเริ่มได้/);
  assert.match(early, /ไม่ต้องรอให้ผู้ใช้กำหนดทุกจังหวะ/);
  assert.match(early, /อย่าจบทุกข้อความด้วยคำถาม/);

  const close = companionPromptBlock({ ...defaultCompanionState(), affinity: 82 });
  assert.match(close, /คุ้นเคยมาก: เริ่มหัวข้อ/);
});

test("clamping: all numeric state stays within 0..100 and never swings to an extreme in one turn", () => {
  assert.equal(clampScore(-50), 0);
  assert.equal(clampScore(250), 100);
  assert.equal(clampScore(NaN), 0);
  const dirty = { affinity: 9999, trust: -99, familiarity: 12345, mood: "nope", moodIntensity: 500, conversationSummary: "x".repeat(5000), lastIdleAt: null, lastInteractionAt: null };
  const clean = sanitizeCompanionState(dirty);
  assert.equal(clean.affinity, 100);
  assert.equal(clean.trust, 0);
  assert.equal(clean.familiarity, 100);
  assert.equal(clean.mood, "calm");
  assert.equal(clean.moodIntensity, 100);
  assert.ok(clean.conversationSummary.length <= 1800);
  // Bounded per-turn: a model-suggested jump to 100 from 20 moves at most +5.
  const current = { ...defaultCompanionState(), affinity: 20, trust: 20, familiarity: 10, moodIntensity: 30 };
  const proposed = validateProposedState(current, { affinity: 100, trust: 0, familiarity: 100, moodIntensity: 100 });
  assert.equal(proposed.affinity, 20 + MAX_DELTA_AFFINITY_PER_TURN);
  assert.equal(proposed.trust, 20 - 5);
  assert.equal(proposed.familiarity, 10 + 3);
  assert.ok(proposed.moodIntensity <= 30 + MAX_DELTA_MOOD_INTENSITY_PER_TURN);
  // One positive turn also moves affinity by at most the cap.
  const next = applyConversationTurn(current, "ขอบคุณ น่ารักมาก", "ค่ะ");
  assert.ok(Math.abs(next.affinity - current.affinity) <= MAX_DELTA_AFFINITY_PER_TURN);
});

test("named bands map to thresholds", () => {
  assert.equal(affinityBand(39), "distant");
  assert.equal(affinityBand(40), "warming");
  assert.equal(affinityBand(69), "warming");
  assert.equal(affinityBand(70), "close");
  assert.equal(trustBand(34), "guarded");
  assert.equal(trustBand(35), "building");
  assert.equal(trustBand(60), "trusting");
  assert.equal(familiarityBand(29), "new");
  assert.equal(familiarityBand(30), "familiar");
  assert.equal(familiarityBand(65), "known");
  assert.equal(moodIntensityBand(39), "subtle");
  assert.equal(moodIntensityBand(40), "noticeable");
  assert.equal(moodIntensityBand(70), "strong");
  // Thai prompt hints still surface the bands, short and token-capped.
  const block = companionPromptBlock({ ...defaultCompanionState(), affinity: 82, trust: 90, familiarity: 80 });
  assert.match(block, /close/);
  assert.match(block, /trusting/);
  assert.ok(block.length < 1200, `state hint block is short (${block.length})`);
  assert.equal(boundedDelta(50, 999, 5), 55);
  assert.equal(boundedDelta(50, -999, 5), 45);
});

test("decay to neutral: mood fades to calm over time, long-term state persists", () => {
  const state = { ...defaultCompanionState(), mood: "melancholy", moodIntensity: 60, affinity: 70, trust: 60, familiarity: 50, lastInteractionAt: new Date(Date.now() - 48 * 3_600_000).toISOString() };
  const faded = decayCompanionState(state);
  assert.equal(faded.mood, "calm");
  assert.ok(faded.moodIntensity < 60);
  assert.equal(faded.affinity, 70);
  assert.equal(faded.trust, 60);
  assert.equal(faded.familiarity, 50);
  // No decay when recent.
  const recent = { ...state, lastInteractionAt: new Date().toISOString() };
  assert.deepEqual(decayCompanionState(recent, Date.now() + 1000), recent);
});
