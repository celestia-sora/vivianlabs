import type { Mood } from "@/lib/companion";

/**
 * Pure 3D VRM & FBX emotion engine.
 * Keeps Vivian's exact ElevenLabs tag + mood + Thai/EN/JA/ZH text scoring
 * rules from vivianlabs, and resolves emotions onto:
 *  - VRM 1.0 presets (`happy`, `angry`, `sad`, `relaxed`, `surprised`, `neutral`)
 *  - VRM 0.x presets (`joy`, `angry`, `sorrow`, `fun`, `surprised`, `neutral`)
 *  - Custom VRM expressions & FBX ARKit/MMD/Blender morph targets
 *  - Embedded or companion 3D animation clips
 *  - Procedural upper-body/head reactions so every emotion feels alive
 */

export type AvatarEmotion =
  | "happy" | "laugh" | "sad" | "angry" | "surprised" | "confused"
  | "tired" | "blush" | "love" | "tease" | "eyes" | "phone" | "tea"
  | "hair" | "thinking" | "calm";

/** Compatibility alias for code/tests migrated from vivianlabs. */
export type Live2DEmotion = AvatarEmotion;

interface EmotionRule {
  emotion: AvatarEmotion;
  pattern: RegExp;
  weight: number;
}

const TEXT_RULES: EmotionRule[] = [
  { emotion: "sad", pattern: /เศร้า|เสียใจ|ร้องไห้|เหงา|หดหู่|เศร้าสร้อย|กลัว|กังวล|วิตก|กังวลใจ|sad|cry|tear|lonely|depressed|afraid|anxious|worried|悲|哭|难过|伤心|心痛|伤感|悲し|泣|涙|寂し|不安/i, weight: 3 },
  { emotion: "angry", pattern: /โกรธ|โมโห|หงุดหงิด|รำคาญ|ไม่พอใจ|งอน|angry|mad|annoyed|upset|furious|pout|怒|生气|愤怒|恼火|怒り|ぷん|怒っ/i, weight: 3 },
  { emotion: "surprised", pattern: /ตกใจ|ว้าว|จริงเหรอ|ไม่น่าเชื่อ|หา\?|ห๊ะ|เอ๊ะ|surprise|wow|really\?|shocked|startled|惊|吃惊|惊讶|讶|驚|驚き|ビックリ|まじ|えっ/i, weight: 2 },
  { emotion: "tired", pattern: /ง่วง|เพลีย|อยากนอน|เหนื่อย|พักผ่อน|อ่อนล้า|tired|sleepy|exhausted|sleep|眠|困|累|疲|辛|しんど|眠い/i, weight: 2 },
  { emotion: "blush", pattern: /เขิน|หน้าแดง|อาย|ชม|หยอด|หึง|หวง|fluster|blush|shy|embarrass|jealous|possessive|脸红|害羞|羞|照れ|恥|ドキドキ/i, weight: 2 },
  { emotion: "love", pattern: /รัก|คิดถึง|กอด|ห่วงใย|love|miss you|hug|care for|affection|crush|爱|好き|好|爱し|รักนะ|คิดถึงนะ/i, weight: 2 },
  { emotion: "laugh", pattern: /ขำ|ตลก|หัวเราะ|มุก|ฮ่า|haha|lol|funny|joke|laugh|chuckle|giggle|哈哈|大笑|笑い|あはは|ウケ/i, weight: 2 },
  { emotion: "tease", pattern: /แกล้ง|หยอก|ล้อเล่น|ทะเล้น|จุ๊บ|จูบ|kiss|tease|tongue|wink|吐舌|眨眼|ウィンク|チュー/i, weight: 2 },
  { emotion: "eyes", pattern: /มอง|ตามอง|ดูนี่|กระพริบ|หลับตา|eyes|look|blink|watch|gaze|目|眼|観|見る|瞬き/i, weight: 1 },
  { emotion: "phone", pattern: /โทรศัพท์|โทรหา|สายโทร|แจ้งเตือน|ข้อความ|notification|phone|call|text me|スマホ|携帯|手机|来电|消息/i, weight: 1 },
  { emotion: "tea", pattern: /(?:ดื่ม|จิบ)ชา|กาแฟ|ชาเขียว|drink|tea|coffee|お茶|茶|咖啡|喝茶/i, weight: 1 },
  { emotion: "hair", pattern: /ทรงผม|ผมยาว|ผมสั้น|หวีผม|ทำผม|ตัดผม|แต่งตัว|แต่งหน้า|แฟชั่น|สวย|ดูดี|hair|hairstyle|makeup|fashion|pretty|beautiful|髪|化粧|お洒落/i, weight: 1 },
  { emotion: "confused", pattern: /อะไรนะ|งง|ไม่เข้าใจ|ทำไม|what\?|huh|confused|don't understand|困惑|疑问|为什么|なぜ|なんで|分からない/i, weight: 1 },
  { emotion: "thinking", pattern: /คิดว่า|คิดดู|ครุ่นคิด|คิดอยู่|hmm|thinking|thoughtful|思考|考え|悩|うーん/i, weight: 1 },
  { emotion: "happy", pattern: /ดีใจ|ตื่นเต้น|เยี่ยม|สุดยอด|ฉลอง|ยิ้ม|สวัสดี|ทักทาย|ขอบคุณ|สุขสันต์|happy|excited|great|awesome|celebrate|smile|hello|thank|开心|微笑|开怀|笑顔|にっこり|嬉し/i, weight: 2 },
];

const TAG_TO_EMOTION: Record<string, AvatarEmotion> = {
  curious: "confused", playful: "tease", thoughtful: "thinking", content: "happy",
  anxious: "sad", tired: "tired", startled: "surprised", sad: "sad", excited: "happy",
  happy: "happy", laughs: "laugh", laughing: "laugh", chuckles: "laugh", giggles: "laugh",
  sighs: "tired", exhales: "tired", gasps: "surprised",
  whispers: "calm", whispering: "calm", softly: "calm", quietly: "calm",
  shouts: "angry", shouting: "angry", rushed: "surprised",
  weak: "tired", angry: "angry", bored: "tired", menacing: "angry", amazed: "surprised",
  powerful: "angry", proud: "happy", optimistic: "happy", mad: "angry", aggressive: "angry",
  bitter: "angry", critical: "angry", repelled: "angry", stressed: "sad", scared: "sad",
  threatened: "sad", vulnerable: "sad", confused: "confused", busy: "thinking", distant: "calm",
  despair: "sad", "let down": "sad", peaceful: "calm", trusting: "love",
};

const CHARACTER_CUE_RULES: Array<[RegExp, AvatarEmotion]> = [
  [/fluster|embarrass|shy|blush|composed/i, "blush"],
  [/teas|playful|cheeky|mischiev/i, "tease"],
  [/warm|affection|tender|gentle|fond|amused/i, "love"],
  [/sad|down|hurt|glum|gloomy|worried|anxious/i, "sad"],
  [/annoyed|irritated|frustrated|angry|cross/i, "angry"],
  [/surprise|startled|amazed|shocked/i, "surprised"],
  [/tired|weary|exhausted|sleepy/i, "tired"],
  [/excited|thrilled|delighted|cheerful|bright/i, "happy"],
  [/curious|puzzled|confused|questioning/i, "confused"],
];

export function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/\[\s*([^\]]{1,80})\s*\]/g)) tags.push(match[1].trim());
  return tags;
}

function moodBonus(mood: Mood, intensity: number): Partial<Record<AvatarEmotion, number>> {
  const scale = intensity >= 70 ? 1.5 : 1;
  switch (mood) {
    case "warm": return { happy: scale, love: scale * 0.5 };
    case "playful": return { tease: scale, laugh: scale * 0.5, happy: scale * 0.5 };
    case "tired": return { tired: scale, tea: scale * 0.5 };
    case "melancholy": return { sad: scale };
    case "yandere": return { blush: scale, angry: scale * 0.5 };
    default: return { calm: scale * 0.5 };
  }
}

const PRIORITY: AvatarEmotion[] = [
  "sad", "angry", "surprised", "tired", "blush", "love", "laugh", "happy",
  "tease", "confused", "thinking", "eyes", "phone", "tea", "hair", "calm",
];

export function detectAvatarEmotion(options: {
  reply: string;
  userText: string;
  mood: Mood;
  intensity: number;
  idle?: boolean;
}): AvatarEmotion {
  const tags = extractEmotionTags(options.reply);
  if (tags[0]) {
    const leadingKey = tags[0].toLowerCase().split(/[,]/)[0].trim();
    const leading = TAG_TO_EMOTION[leadingKey];
    if (leading) return leading;
  }
  const combined = `${options.reply} ${options.userText}`;
  const scores = new Map<AvatarEmotion, number>();
  const add = (emotion: AvatarEmotion, value: number) => scores.set(emotion, (scores.get(emotion) ?? 0) + value);

  for (const tag of tags) {
    const key = tag.toLowerCase();
    const direct = TAG_TO_EMOTION[key.split(/[,]/)[0].trim()];
    if (direct) { add(direct, 3); continue; }
    for (const [pattern, emotion] of CHARACTER_CUE_RULES) {
      if (pattern.test(tag)) { add(emotion, 2); break; }
    }
  }

  for (const [emotion, value] of Object.entries(moodBonus(options.mood, options.intensity)) as Array<[AvatarEmotion, number]>) {
    add(emotion, value);
  }

  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(combined)) add(rule.emotion, rule.weight);
  }

  if (options.idle && options.mood === "tired") add("tea", 2);

  let best: AvatarEmotion = "calm";
  let bestScore = -Infinity;
  for (const emotion of PRIORITY) {
    const score = scores.get(emotion) ?? 0;
    if (score > bestScore) { best = emotion; bestScore = score; }
  }
  return best;
}

export const detectLive2DEmotion = detectAvatarEmotion;

/** Ordered VRM 1.0 / VRM 0.x / custom expression candidates per emotion. */
export const VRM_EXPRESSION_CANDIDATES: Record<AvatarEmotion, Array<{ name: string; weight: number }>> = {
  happy: [{ name: "happy", weight: 0.85 }, { name: "joy", weight: 0.85 }, { name: "smile", weight: 0.85 }, { name: "fun", weight: 0.7 }],
  laugh: [{ name: "happy", weight: 1.0 }, { name: "joy", weight: 1.0 }, { name: "fun", weight: 0.9 }, { name: "laugh", weight: 1.0 }],
  sad: [{ name: "sad", weight: 0.85 }, { name: "sorrow", weight: 0.85 }, { name: "cry", weight: 0.75 }],
  angry: [{ name: "angry", weight: 0.85 }, { name: "pout", weight: 0.85 }, { name: "mad", weight: 0.85 }],
  surprised: [{ name: "surprised", weight: 0.9 }, { name: "surprise", weight: 0.9 }, { name: "shock", weight: 0.85 }],
  confused: [{ name: "surprised", weight: 0.35 }, { name: "confused", weight: 0.8 }, { name: "thinking", weight: 0.7 }],
  tired: [{ name: "relaxed", weight: 0.7 }, { name: "sad", weight: 0.35 }, { name: "tired", weight: 0.85 }, { name: "sleepy", weight: 0.8 }],
  blush: [{ name: "blush", weight: 1.0 }, { name: "shy", weight: 0.9 }, { name: "embarrassed", weight: 0.9 }, { name: "relaxed", weight: 0.55 }, { name: "happy", weight: 0.45 }],
  love: [{ name: "love", weight: 1.0 }, { name: "blush", weight: 0.85 }, { name: "relaxed", weight: 0.75 }, { name: "happy", weight: 0.65 }],
  tease: [{ name: "wink", weight: 0.9 }, { name: "smug", weight: 0.85 }, { name: "fun", weight: 0.85 }, { name: "happy", weight: 0.65 }],
  eyes: [{ name: "relaxed", weight: 0.5 }, { name: "neutral", weight: 0.5 }],
  phone: [{ name: "relaxed", weight: 0.5 }, { name: "neutral", weight: 0.5 }],
  tea: [{ name: "relaxed", weight: 0.8 }, { name: "happy", weight: 0.4 }],
  hair: [{ name: "happy", weight: 0.55 }, { name: "relaxed", weight: 0.6 }],
  thinking: [{ name: "thinking", weight: 0.8 }, { name: "relaxed", weight: 0.3 }, { name: "neutral", weight: 0.6 }],
  calm: [{ name: "neutral", weight: 1.0 }, { name: "relaxed", weight: 0.25 }],
};

const GENERIC_EXPRESSION_PATTERNS: Record<AvatarEmotion, RegExp> = {
  happy: /happy|smile|joy|warm|fun|微笑|开心|笑顔|にっこり|嬉し|ยิ้ม/i,
  laugh: /laugh|chuckle|giggle|joy|happy|大笑|哈哈|笑い/i,
  sad: /sad|sorrow|cry|tear|depress|melancholy|悲|哭|悲し|เศร้า/i,
  angry: /angry|mad|annoy|upset|pout|怒|生气|怒り|โกรธ|งอน/i,
  surprised: /surprise|shock|startl|惊|驚|ตกใจ/i,
  confused: /confus|question|puzzl|困惑|งง/i,
  tired: /tired|sleep|exhaust|relax|眠|困|累|ง่วง|เหนื่อย/i,
  blush: /blush|shy|fluster|embarrass|cheek|脸红|害羞|照れ|เขิน/i,
  love: /love|affection|crush|heart|blush|爱|好き|愛|รัก/i,
  tease: /tease|tongue|wink|smug|fun|吐舌|眨|ウィンク|แกล้ง/i,
  eyes: /eyes|look|blink|gaze|目|眼/i,
  phone: /phone|call|message/i,
  tea: /tea|coffee|relax|calm/i,
  hair: /hair|style|pretty|happy/i,
  thinking: /think|ponder|curious|思考|考え/i,
  calm: /neutral|normal|default|calm|idle|relax/i,
};

export interface ResolvedExpressionTarget {
  name: string;
  weight: number;
}

/** Resolve an AvatarEmotion to the best matching VRM or FBX expression name & target weight. */
export function resolve3DExpression(
  emotion: AvatarEmotion,
  supported: readonly string[],
): ResolvedExpressionTarget | null {
  if (!supported.length) return null;
  const lowerMap = new Map<string, string>();
  for (const item of supported) lowerMap.set(item.trim().toLowerCase(), item);

  for (const candidate of VRM_EXPRESSION_CANDIDATES[emotion] ?? []) {
    const exact = lowerMap.get(candidate.name.toLowerCase());
    if (exact) return { name: exact, weight: candidate.weight };
  }
  const pattern = GENERIC_EXPRESSION_PATTERNS[emotion];
  const fallback = supported.find((name) => pattern.test(name));
  if (fallback) return { name: fallback, weight: 0.8 };
  return null;
}

/** Compatibility wrapper returning only the expression name. */
export function resolveLive2DExpression(emotion: AvatarEmotion, supported: readonly string[]): string | null {
  return resolve3DExpression(emotion, supported)?.name ?? null;
}

/**
 * Resolve multi-morph ARKit / Blender / MMD weights for FBX meshes that expose
 * granular morph targets (e.g., `mouthSmileLeft` + `mouthSmileRight`).
 */
export function resolveFbxMorphWeights(
  emotion: AvatarEmotion,
  morphNames: readonly string[],
): Record<string, number> {
  const weights: Record<string, number> = {};
  const matchAll = (pattern: RegExp, weight: number) => {
    for (const name of morphNames) {
      if (pattern.test(name)) weights[name] = Math.max(weights[name] ?? 0, weight);
    }
  };
  switch (emotion) {
    case "happy":
      matchAll(/mouthSmile|smile|happy|joy|笑顔|にっこり/i, 0.75);
      matchAll(/cheekSquint|eyeSquint/i, 0.4);
      break;
    case "laugh":
      matchAll(/mouthSmile|smile|happy|joy|laugh|笑顔/i, 0.95);
      matchAll(/cheekSquint|eyeSquint/i, 0.65);
      break;
    case "sad":
      matchAll(/mouthFrown|sad|sorrow|悲|泣/i, 0.8);
      matchAll(/browInnerUp/i, 0.65);
      break;
    case "angry":
      matchAll(/browDown|angry|mad|pout|怒/i, 0.85);
      matchAll(/mouthFrown|mouthPress|noseSneer/i, 0.45);
      break;
    case "surprised":
      matchAll(/eyeWide|browInnerUp|browOuterUp|surpris|驚/i, 0.8);
      matchAll(/jawOpen|mouthFunnel/i, 0.35);
      break;
    case "blush":
    case "love":
      matchAll(/blush|shy|cheek|照れ|赤面/i, 0.9);
      matchAll(/mouthSmile|smile/i, 0.45);
      break;
    case "tease":
      matchAll(/wink|eyeBlinkLeft|mouthSmile|smug|tongueOut|ウィンク/i, 0.75);
      break;
    case "tired":
      matchAll(/eyeSquint|relax|tired|sleepy|眠/i, 0.55);
      break;
    case "confused":
    case "thinking":
      matchAll(/browInnerUp|browOuterUpLeft|mouthPucker|think|confus/i, 0.55);
      break;
    default:
      break;
  }
  if (!Object.keys(weights).length) {
    const single = resolve3DExpression(emotion, morphNames);
    if (single) weights[single.name] = single.weight;
  }
  return weights;
}

const GENERIC_MOTION_PATTERNS: Record<AvatarEmotion, RegExp> = {
  happy: /happy|smile|excited|warm|cheer|wave|joy|喜|笑|嬉し/i,
  laugh: /laugh|chuckle|giggle|happy|笑/i,
  sad: /sad|cry|down|depress|悲|泣/i,
  angry: /angry|mad|pout|cross|怒/i,
  surprised: /surprise|shock|startle|惊|驚/i,
  confused: /think|confus|shrug|困惑|考え/i,
  tired: /tired|sleep|yawn|sigh|rest|眠/i,
  blush: /blush|shy|embarrass|warm|照れ/i,
  love: /love|heart|warm|hug|bow|愛/i,
  tease: /tease|wink|playful|dance|cheeky/i,
  eyes: /look|idle|stand/i,
  phone: /phone|text|idle/i,
  tea: /tea|relax|sit|idle/i,
  hair: /hair|pose|idle/i,
  thinking: /think|ponder|curious|考え/i,
  calm: /idle|stand|breath|wait|待機|待机/i,
};

export function resolve3DMotion(emotion: AvatarEmotion, availableClips: readonly string[]): string | null {
  if (!availableClips.length) return null;
  const pattern = GENERIC_MOTION_PATTERNS[emotion];
  const hit = availableClips.find((name) => pattern.test(name));
  if (hit) return hit;
  return availableClips.find((name) => /idle|stand|breath|wait/i.test(name)) ?? null;
}

export const resolveLive2DMotion = resolve3DMotion;

/**
 * Procedural upper-body & head micro-gesture offsets (radians) applied smoothly
 * during an AI turn so VRM & FBX avatars visibly react even without clip files.
 */
export interface ProceduralEmotionPose {
  headPitch: number;
  headYaw: number;
  headRoll: number;
  spinePitch: number;
  durationSec: number;
}

export const PROCEDURAL_EMOTION_POSE: Record<AvatarEmotion, ProceduralEmotionPose> = {
  happy: { headPitch: -0.05, headYaw: 0.04, headRoll: 0.07, spinePitch: -0.02, durationSec: 2.4 },
  laugh: { headPitch: -0.08, headYaw: 0.0, headRoll: 0.09, spinePitch: -0.04, durationSec: 2.6 },
  sad: { headPitch: 0.14, headYaw: -0.05, headRoll: -0.06, spinePitch: 0.05, durationSec: 3.0 },
  angry: { headPitch: 0.06, headYaw: -0.1, headRoll: -0.05, spinePitch: -0.03, durationSec: 2.5 },
  surprised: { headPitch: -0.1, headYaw: 0.0, headRoll: 0.03, spinePitch: -0.05, durationSec: 1.8 },
  confused: { headPitch: 0.02, headYaw: 0.05, headRoll: 0.14, spinePitch: 0.0, durationSec: 2.5 },
  tired: { headPitch: 0.11, headYaw: 0.03, headRoll: -0.07, spinePitch: 0.04, durationSec: 3.2 },
  blush: { headPitch: 0.09, headYaw: 0.15, headRoll: 0.08, spinePitch: 0.02, durationSec: 2.8 },
  love: { headPitch: 0.04, headYaw: 0.06, headRoll: 0.1, spinePitch: 0.02, durationSec: 2.8 },
  tease: { headPitch: -0.03, headYaw: -0.09, headRoll: 0.11, spinePitch: -0.02, durationSec: 2.3 },
  eyes: { headPitch: 0.0, headYaw: 0.06, headRoll: 0.03, spinePitch: 0.0, durationSec: 2.0 },
  phone: { headPitch: 0.08, headYaw: -0.04, headRoll: -0.03, spinePitch: 0.02, durationSec: 2.0 },
  tea: { headPitch: 0.03, headYaw: 0.0, headRoll: 0.04, spinePitch: 0.01, durationSec: 2.5 },
  hair: { headPitch: -0.02, headYaw: 0.08, headRoll: 0.07, spinePitch: 0.0, durationSec: 2.2 },
  thinking: { headPitch: -0.04, headYaw: -0.08, headRoll: 0.1, spinePitch: 0.0, durationSec: 2.6 },
  calm: { headPitch: 0.0, headYaw: 0.0, headRoll: 0.0, spinePitch: 0.0, durationSec: 1.5 },
};
