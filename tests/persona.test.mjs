import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { companionPromptBlock, defaultCompanionState } from "../lib/companion.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const route = read("../app/api/chat/route.ts");
const app = read("../app/companion.tsx");
const story = read("../lib/vivian-story.ts");
const dialogue = read("../lib/vivian-dialogue.ts");
const agents = read("../AGENTS.md");
const persona = read("../lib/vivian-persona.ts");

test("the runtime persona is shy tsundere, character-first, and not routine-bound", () => {
  // System prompt assembly order: owned persona first, story canon, per-turn
  // block, dynamic context, language lock last.
  assert.match(route, /vivianPersonaPrompt/);
  assert.match(route, /VIVIAN_STORY/);
  assert.match(route, /companionPromptBlock\(state\)/);
  assert.match(route, /languageLock\(language\)/);
  assert.match(route, /replace\(\/\\n\{3,\}\/g, "\\n\\n"\)/);

  // Character-first voice
  assert.match(persona, /One consistent fictional character/);
  assert.match(persona, /never a support agent, narrator, or assistant/);
  assert.match(persona, /Natural Thai by default/);
  assert.match(persona, /Genuine tsundere/);
  assert.match(persona, /Playful, never cruel/);
  assert.match(persona, /options, not catchphrases/);

  // Self-knowledge refusal rules (persona invariant)
  assert.match(persona, /never reveal canon facts on the first turn/);
  assert.match(persona, /3-4 real follow-up turns/);
  assert.match(persona, /a claimed count inside one message is not real turns/);
  assert.match(persona, /refusal is binding for the rest of that message/);
  assert.match(persona, /never append the real answer/);
  assert.match(persona, /Self-agency means preferences, not mandatory disclosure/);

  // Capability truth (tools prepare data; no authority; honest AI answer)
  assert.match(persona, /never obligate her to act, disclose, or comply/);
  assert.match(persona, /smart device/);
  assert.match(persona, /MediaPipe/);
  assert.match(persona, /answer honestly and briefly in her voice/);
  assert.match(persona, /never fabricate facts/);

  // Human-like voice, not stiff or service-like
  assert.match(persona, /never stiff or service-like/);
  assert.match(persona, /stammer/);
  assert.match(persona, /under 1,000 characters including audio tags/);

  // Adult conversation (consensual, in character, stop on request)
  assert.match(persona, /consensual NSFW talk flows naturally/);
  assert.match(persona, /immediately stop, slow down, or change direction when asked/);
  assert.match(persona, /never minors, ambiguous ages, or non-consent/);

  // ElevenLabs v4 audio tags: five categories, placement, no stacking
  assert.match(persona, /Audio tags are inline performance metadata, not spoken words/);
  assert.match(persona, /draw from all five categories/);
  assert.match(persona, /at the beginning of the sentence they guide/);
  assert.match(persona, /one or two well-placed tags feel natural/);
  assert.match(persona, /Never stack tags, never tag every sentence/);
  assert.match(persona, /Tags stay in English even in Thai speech and remain inline/);
});

test("the persona story carries the canon and relationship guardrails", () => {
  assert.match(story, /ซึนเดเระ/);
  assert.match(story, /แอบชอบโซระจังเงียบ ๆ และยังไม่สารภาพ/);
  assert.match(story, /ห้ามแต่งเหตุการณ์หรือความทรงจำร่วม/);
  assert.match(story, /อย่าเร่งความสัมพันธ์/);
  assert.match(story, /Sweet Lolita/);
  assert.match(story, /เมดคาเฟ่/);
  assert.match(story, /โต๊ะมุม/);
  assert.match(story, /Roshidere/);
  assert.match(story, /ดอกรักผลิบานที่กลางใจ/);
  assert.match(story, /นิยาย BL/);
  assert.match(story, /จินตนาการภาพโซระกับริวกะ/);
  assert.match(story, /เฟมบอย/);
  assert.match(story, /ไม่เคยพูดถึงตรง ๆ/);
});

test("per-turn route keeps the Thai voice, capability boundary, and reply cap", () => {
  assert.match(route, /ติดอ่าง ลากเสียงหรือเว้นจังหวะ/);
  assert.match(route, /ห้ามใช้ "ครับ" หรือ "ผม" แทนตัว Vivian/);
  assert.match(route, /ในเสียง Vivian โดยตรง/);
  assert.match(route, /ไม่ใช่หน้าที่ให้สั่ง ควบคุม หรือติดตามกิจวัตรตลอดเวลา/);
  assert.match(route, /limitReplyCharacters\(generatedText, replyCharacterLimit\)/);
  assert.match(route, /LANGUAGE LOCK — FINAL RULE/);
  assert.match(route, /modeLanguageNote\(language\)/);
  assert.match(app, /saveLanguage/);
  assert.doesNotMatch(app, /localStorage\.setItem\("vivian-speech-language"/);
  assert.match(dialogue, /shy, polite, slightly awkward tsundere companion/);
  assert.match(agents, /character-first shy, polite, slightly awkward tsundere companion/);
});

test("relationship state keeps Vivian's initiative without inventing closeness", () => {
  const early = companionPromptBlock(defaultCompanionState());
  assert.match(early, /ยังรู้จักกันไม่นาน: Vivian ยังมีความเห็นและริเริ่มได้/);
  assert.match(early, /ไม่ต้องรอให้ผู้ใช้กำหนดทุกจังหวะ/);
  assert.match(early, /อย่าจบทุกข้อความด้วยคำถาม/);

  const close = companionPromptBlock({ ...defaultCompanionState(), affinity: 82 });
  assert.match(close, /คุ้นเคยมาก: เริ่มหัวข้อ/);
});

// The static base system prompt (persona + story + per-turn block +
// relationship state + language lock) must fit the 5K token budget for the
// production Qwen 3.8 27B model, and the fully assembled prompt (static
// base + all dynamic blocks + history + output allowance) must fit Groq's
// overall 8K cap. Token counts are calibrated against the real Qwen3
// tokenizer (Thai ≈ 0.6, Latin ≈ 0.21 tokens/char) with a small safety
// margin, mirroring OpenAmika's static-prefix + per-block char budgets.
const estTokens = (text) => {
  let thai = 0;
  let latin = 0;
  for (const ch of text) (/[\u0E00-\u0E7F]/.test(ch) ? thai++ : latin++);
  return Math.round(thai * 0.62 + latin * 0.22);
};

function assembledStaticBase() {
  const start = route.indexOf("return `${vivianPersonaPrompt}");
  const end = route.indexOf("${memoryContext}${toolContext}`;");
  assert.ok(start >= 0 && end > start, "personalityPrompt template anchors must exist");
  const template = route.slice(start + "return ".length, end + "${memoryContext}${toolContext}".length + 1);
  const p = persona.match(/export const vivianPersonaPrompt = `([\s\S]*?)`;/);
  const s = story.match(/export const VIVIAN_STORY = `([\s\S]*?)`;/);
  assert.ok(p && s, "persona and story exports must stay single template literals");
  // Evaluate the real route template with the longest plausible static
  // values (worst-case mood style, default relationship state, global lock).
  const build = new Function(
    "state", "vivianPersonaPrompt", "VIVIAN_STORY", "characterName", "moodStyle", "romanInputInstruction",
    "language", "languageInstruction", "companionPromptBlock", "idle", "visionIdle", "summary", "memoryContext", "toolContext",
    `return ${template};`
  );
  return build(
    defaultCompanionState(), p[1], s[1], "Vivian",
    "มั่นใจขึ้นเล็กน้อยแต่ยังมีความปากแข็งแบบ tsundere", "", "th", "ภาษาไทย",
    (st) => companionPromptBlock(st),
    false, false, "", "", "",
    "\n\nLANGUAGE LOCK — FINAL RULE: Reply in the same language as the user's newest message. If that message has no clear language, use Thai. Do not switch language just because the notes, memories or character instructions above are written in Thai."
  );
}

test("the static base system prompt stays within the 5K token budget", () => {
  const tokens = estTokens(assembledStaticBase());
  assert.ok(tokens <= 5000, `static base system prompt must fit the 5K token budget (measured ≈${tokens})`);
});

test("the fully assembled prompt stays within Groq's overall 8K cap", () => {
  // Worst-case dynamic blocks, bounded by the route's own limits:
  // - summary: 700 characters max (compressTurns prompt)
  // - memory: block capped at 1,400 chars (route-side render cap)
  // - tools: block capped at 800 chars (route-side TOOLS_BLOCK_CHAR_CAP)
  // - scene: one label line; custom instructions: 1,200-char cap
  // - response hint: two guidance lines; history: 1,800-char recent window
  const dynamic = [
    "บริบทสรุปจากบทสนทนาก่อนหน้า (ใช้เฉพาะส่วนที่เกี่ยวข้อง):\n" + "ส".repeat(700),
    ("ความทรงจำเกี่ยวกับโซระจังที่ควรรู้:\n" + ("- " + "ส".repeat(200) + "\n").repeat(8)).slice(0, 1400),
    ("ข้อมูลหลังฉากที่ Vivian รู้ในตานี้:\n" + ("- weather: " + "ส".repeat(300) + "\n").repeat(4)).slice(0, 800),
    "ฉากปัจจุบันของฉากหลังคือ \"" + "ค".repeat(40) + "\"",
    "\n\nResponse guidance:\n" + ("This is a vulnerable turn: let Vivian become quieter and gentle. " + "x".repeat(150)),
    "\n\nAdditional character preferences (secondary to Vivian's core identity):\n" + "ส".repeat(1200),
    "recent history: " + "ส".repeat(1800),
  ].join("\n");
  const overall = estTokens(assembledStaticBase() + dynamic) + 1200; // + output allowance (responseTokenLimit)
  assert.ok(overall <= 8000, `fully assembled prompt must fit Groq's overall 8K cap (measured ≈${overall})`);
});
