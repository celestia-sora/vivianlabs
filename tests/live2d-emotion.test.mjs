import assert from "node:assert/strict";
import test from "node:test";
import { detectLive2DEmotion, extractEmotionTags, resolveLive2DExpression, resolveLive2DMotion } from "../lib/live2d-emotion.ts";

const go = (reply, userText = "", mood = "calm", intensity = 35, idle = false) => detectLive2DEmotion({ reply, userText, mood, intensity, idle });

test("voice tags win over plain words and calm mood", () => {
  assert.equal(go("[sad] วันนี้เธอเหนื่อยใช่ไหม", "วันนี้แย่จัง", "calm"), "sad");
  assert.equal(go("[sad] ฉันฟังอยู่", "", "warm", 80), "sad");
  assert.equal(go("[curious] จริงเหรอ", "", "calm"), "confused");
  assert.equal(go("[startled] หา!?", "", "calm"), "surprised");
  assert.equal(go("[slightly flustered, trying to sound composed] ไม่ได้เขิน", "", "calm"), "blush");
  assert.equal(go("[dryly teasing, restrained] ตาบ้าเอ๊ย", "", "calm"), "tease");
});

test("thai keywords score without the old substring traps", () => {
  assert.equal(go("กลับคฤหาสน์กันเถอะ", "ตามนี้เลย", "calm"), "calm");
  assert.equal(go("ดูนี่สิ", "ตามสบาย", "calm"), "eyes");
  assert.equal(go("ง่วงแล้วไปนอนกัน", "วันนี้เหนื่อย", "calm"), "tired");
  assert.equal(go("ดื่มชากัน", "หิวน้ำจัง", "calm"), "tea");
  assert.equal(go("ผมชอบชา", "บอกหน่อย", "calm"), "calm");
  assert.equal(go("ผมยาวกว่านี้สวยไหม", "ทำผมใหม่", "calm"), "hair");
  assert.equal(go("น่ารักจัง", "ชมให้หน่อย", "yandere", 70), "blush");
  assert.equal(go("555 ขำจัง", "มุกนี้ดี", "playful", 80), "laugh");
});

test("distress outranks flustered words and idle tired keeps the tea rest", () => {
  assert.equal(go("อย่าร้องไห้เลย นะ", "ฉันเศร้าต้องการกำลังใจ", "yandere", 90), "sad");
  assert.equal(go("พักหน่อยนะ", "", "tired", 80, true), "tea");
  assert.equal(go("พักหน่อยนะ", "", "tired", 80, false), "tired");
});

test("leading tag wins over conflicting text and mood", () => {
  assert.equal(go("[playful] เศร้าจัง sad", "เศร้าต้องการกำลังใจ", "melancholy", 90), "tease");
  assert.equal(go("[playful] โกรธ", "", "melancholy", 90), "tease");
  assert.equal(go("[sad] ตาบ้าเอ๊ย หยอก", "", "playful", 80), "sad");
});

test("every built-in ElevenLabs emotion tag resolves to a non-null emotion", () => {
  const expected = { weak: "tired", angry: "angry", bored: "tired", menacing: "angry", playful: "tease", tired: "tired", excited: "happy", amazed: "surprised", powerful: "angry", proud: "happy", optimistic: "happy", startled: "surprised", mad: "angry", aggressive: "angry", bitter: "angry", critical: "angry", repelled: "angry", anxious: "sad", stressed: "sad", scared: "sad", threatened: "sad", vulnerable: "sad", confused: "confused", busy: "thinking", distant: "calm", despair: "sad", "let down": "sad", peaceful: "calm", content: "happy", curious: "confused", thoughtful: "thinking", trusting: "love" };
  assert.equal(Object.keys(expected).length, 32);
  for (const [tag, emotion] of Object.entries(expected)) {
    assert.equal(go(`[${tag}] ได้เลย`, "", "calm"), emotion, `tag [${tag}] -> ${emotion}`);
  }
});

test("Nariell auto-expression denylist never returns color names", () => {
  const nariell = ["color change 1", "color eyes 1", "color hair 1", "tail onoff", "chibi onoff", "closed eyes", "arm updown", "blush", "cry", "scared", "heart eyes"];
  assert.equal(resolveLive2DExpression("eyes", nariell), "closed eyes");
  assert.equal(resolveLive2DExpression("eyes", ["color eyes 1", "color eyes 2"]), null);
  assert.equal(resolveLive2DExpression("hair", ["color hair 1", "color hair 2"]), null);
  assert.equal(resolveLive2DExpression("sad", ["color change 1", "cry"]), "cry");
  assert.equal(resolveLive2DExpression("calm", ["chibi onoff", "tail onoff"]), null);
  assert.equal(resolveLive2DExpression("eyes", ["color eyes 1", "heart eyes"]), "heart eyes");
});

test("miss map, generic models and motions resolve", () => {
  assert.equal(resolveLive2DExpression("blush", ["#", "M lianhong", "M miyan"]), "M lianhong");
  assert.equal(resolveLive2DExpression("happy", ["#", "M miyan"]), "M miyan");
  assert.equal(resolveLive2DExpression("sad", ["#", "M QAQ"]), "M QAQ");
  assert.equal(resolveLive2DExpression("tired", ["#", "S chabei"]), "S chabei");
  // Non-Miss artist names: Chinese/Japanese are matched generically.
  assert.equal(resolveLive2DExpression("blush", ["#", "脸红", "开心"]), "脸红");
  assert.equal(resolveLive2DExpression("happy", ["通常", "笑顔"]), "笑顔");
  assert.equal(resolveLive2DExpression("sad", ["通常", "悲し"]), "悲し");
  assert.equal(resolveLive2DExpression("angry", ["通常", "怒り"]), "怒り");
  assert.equal(resolveLive2DExpression("happy", ["通常", "开心"]), "开心");
  assert.equal(resolveLive2DExpression("calm", ["通常", "开心"]), "通常");
  assert.equal(resolveLive2DExpression("happy", ["通常"]), null);
  assert.equal(resolveLive2DMotion("happy", ["Idle", "Happy"]), "Happy");
  assert.equal(resolveLive2DMotion("sad", ["Idle", "Sad"]), "Sad");
  assert.equal(resolveLive2DMotion("blush", ["Idle", "Warm"]), "Warm");
  assert.equal(resolveLive2DMotion("happy", ["Idle"]), "Idle");
  assert.equal(resolveLive2DMotion("happy", []), null);
  assert.deepEqual(extractEmotionTags("[playful] สวัสดี [sighs]"), ["playful", "sighs"]);
});
