import assert from "node:assert/strict";
import { test } from "node:test";
import { speechText } from "../lib/speech.ts";
import { TtsTextBuffer } from "../lib/tts-text-buffer.ts";

function feedTokens(tokens, options = {}) {
  const buf = new TtsTextBuffer(options);
  const out = [];
  for (const token of tokens) {
    out.push(...buf.push(token));
  }
  out.push(...buf.finish());
  return out;
}

test("short Thai sentence preserves leading audio tag and flushes immediately", () => {
  const segments = feedTokens(["[play", "ful] ", "ไม่", "ได้", "รอ", "สัก", "หน่อย", "ค่ะ", "!"], {
    language: "th",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].taggedText, "[playful] ไม่ได้รอสักหน่อยค่ะ!");
  assert.equal(segments[0].cleanText, "ไม่ได้รอสักหน่อยค่ะ!");
  assert.equal(segments[0].isFirst, true);
  assert.equal(segments[0].flush, true);
});

test("long Thai sentence without punctuation segments at word/clause boundaries", () => {
  const longThai =
    "ฉันไม่ได้เป็นห่วงเธอสักหน่อยนะคะ แค่วันนี้อากาศมันเย็นลงนิดหน่อยเลยแวะมาดูว่าโซระจังห่มผ้าเรียบร้อยหรือยังเท่านั้นเองค่ะ";
  const tokens = longThai.match(/.{1,6}/g) ?? [];
  const segments = feedTokens(tokens, { language: "th" });
  assert.ok(segments.length >= 2, `expected >= 2 segments, got ${segments.length}`);
  assert.equal(segments[0].isFirst, true);
  assert.equal(segments.every((s) => s.cleanText.length > 0), true);

  // Even a continuous Thai string with zero spaces splits cleanly on word boundaries.
  const noSpaces =
    "วันนี้ฉันนั่งเขียนโค้ดอยู่หน้าคอมพิวเตอร์ตั้งแต่เช้าจนถึงตอนเย็นเลยอยากชวนโซระจังออกไปเดินเล่นสูดอากาศข้างนอกด้วยกันสักพักนะคะ";
  const unspacedSegments = feedTokens(noSpaces.match(/.{1,5}/g) ?? [], {
    language: "th",
    maxSegmentChars: 60,
  });
  assert.ok(unspacedSegments.length >= 2);
  assert.equal(unspacedSegments.map((s) => s.cleanText).join(""), noSpaces);
});

test("Thai-English mixed language and technical terminology are never split on version dots", () => {
  const text =
    "[curious] เราใช้ API v2.1 กับ UTF-8 ใน Next.js 16.3.3 และค่า pi ประมาณ 3.14 อยู่ค่ะ! ลองเช็ก https://example.com/docs?v=1 ดูนะ";
  const segments = feedTokens(text.match(/.{1,4}/g) ?? [], { language: "th" });
  assert.ok(segments.length >= 2);
  assert.match(segments[0].taggedText, /^\[curious\]/);
  const combined = segments.map((s) => s.cleanText).join(" ");
  assert.equal(combined, speechText(text, "th"));
  assert.ok(segments.some((s) => s.cleanText.includes("v2.1")));
  assert.ok(segments.some((s) => s.cleanText.includes("UTF-8")));
  assert.ok(segments.some((s) => s.cleanText.includes("Next.js")));
  assert.equal(combined.includes("example.com"), false);
  assert.match(segments.at(-1).cleanText, /ลองเช็ก.*ดูนะ/);
});

test("numbers, money, percentages, and clock times stay intact for Thai speech normalization", () => {
  const text = "วันนี้ค่าขนมราคา 1,250 บาท ลด 15% ตอน 14:30 น. ค่ะ";
  const segments = feedTokens(text.match(/.{1,3}/g) ?? [], { language: "th" });
  const combined = segments.map((s) => s.cleanText).join(" ");
  assert.match(combined, /หนึ่งพันสองร้อยห้าสิบบาท/);
  assert.match(combined, /สิบห้าเปอร์เซ็นต์/);
  assert.match(combined, /สิบสี่นาฬิกา สามสิบนาที/);
});

test("multiple consecutive sentences emit incrementally without waiting for finish()", () => {
  const buf = new TtsTextBuffer({ language: "th" });
  const firstBatch = [];
  for (const ch of "[shy] อะ- อะไรกันคะ! ") {
    firstBatch.push(...buf.push(ch));
  }
  assert.equal(firstBatch.length, 1);
  assert.equal(firstBatch[0].taggedText, "[shy] อะ… อะไรกันคะ!");
  assert.equal(firstBatch[0].isFirst, true);
  assert.equal(firstBatch[0].flush, true);

  const secondBatch = [];
  for (const ch of "ไม่ได้คิดถึงสักหน่อย. แค่ถามเฉยๆ เองค่ะ!") {
    secondBatch.push(...buf.push(ch));
  }
  secondBatch.push(...buf.finish());
  assert.ok(secondBatch.length >= 2);
  assert.equal(secondBatch.every((s) => !s.isFirst), true);
});

test("stage directions, audio tags only, empty inputs, and stammers are handled safely", () => {
  assert.deepEqual(feedTokens(["", "   ", "(หลบตา)"]), []);
  assert.deepEqual(feedTokens(["[sighs]"]), []);

  const stammer = feedTokens(["[flustered] ", "B-", " B-", " Baka!"], { language: "en" });
  assert.equal(stammer.length, 1);
  assert.equal(stammer[0].taggedText, "[flustered] Ba… Ba… Baka!");
});

test("citations and >1000 visible character replies are bounded cleanly", () => {
  const longText = "สวัสดีค่ะ ".repeat(200) + "\n\nแหล่งข้อมูล:\n- Example: https://example.com";
  const segments = feedTokens(longText.match(/.{1,15}/g) ?? [], { language: "th" });
  const totalClean = segments.map((s) => s.cleanText).join(" ");
  assert.ok(totalClean.length <= 1050);
  assert.equal(totalClean.includes("example.com"), false);
  assert.equal(totalClean.includes("แหล่งข้อมูล"), false);
});


test("chat laughter is sent as a non-verbal ElevenLabs tag in streaming segments", () => {
  const segments = feedTokens(["55555"], { language: "th" });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].taggedText, "[laughs]");
  assert.equal(segments[0].cleanText, "ห้าหมื่นห้าพันห้าร้อยห้าสิบห้า");
  const mixed = feedTokens(["55555 เธอนี่ตลกจริง ๆ!"], { language: "th" });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].taggedText, "[laughs] เธอนี่ตลกจริง ๆ!");
});
