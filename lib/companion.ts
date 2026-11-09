export type Mood = "calm" | "warm" | "playful" | "tired" | "melancholy" | "yandere";

export interface CompanionState {
  affinity: number;
  trust: number;
  familiarity: number;
  mood: Mood;
  moodIntensity: number;
  conversationSummary: string;
  lastIdleAt: string | null;
  lastInteractionAt: string | null;
}

export const MOODS: Mood[] = ["calm", "warm", "playful", "tired", "melancholy", "yandere"];

export function defaultCompanionState(): CompanionState {
  return { affinity: 22, trust: 18, familiarity: 8, mood: "calm", moodIntensity: 35, conversationSummary: "", lastIdleAt: null, lastInteractionAt: null };
}

export function clampScore(value: number) { return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0))); }

// --- Explicit state rules (Phase 3 §9.2) ---
// Bounded numeric state 0..100 with named bands that map to SHORT prompt
// hints. The model may suggest a change, but code validates and clamps it:
// one reply can never swing state to an extreme (per-turn delta caps).
// Mood intensity decays to neutral over time; affinity/trust/familiarity
// are long-term and do not decay.
export const MAX_DELTA_AFFINITY_PER_TURN = 5;
export const MAX_DELTA_TRUST_PER_TURN = 5;
export const MAX_DELTA_FAMILIARITY_PER_TURN = 3;
export const MAX_DELTA_MOOD_INTENSITY_PER_TURN = 15;

export function boundedDelta(current: number, proposed: number, cap: number): number {
  const next = Number.isFinite(proposed) ? proposed : current;
  return clampScore(current + Math.max(-cap, Math.min(cap, next - current)));
}

export type AffinityBand = "distant" | "warming" | "close";
export type TrustBand = "guarded" | "building" | "trusting";
export type FamiliarityBand = "new" | "familiar" | "known";
export type MoodIntensityBand = "subtle" | "noticeable" | "strong";

export function affinityBand(value: number): AffinityBand {
  return value >= 70 ? "close" : value >= 40 ? "warming" : "distant";
}
export function trustBand(value: number): TrustBand {
  return value >= 60 ? "trusting" : value >= 35 ? "building" : "guarded";
}
export function familiarityBand(value: number): FamiliarityBand {
  return value >= 65 ? "known" : value >= 30 ? "familiar" : "new";
}
export function moodIntensityBand(value: number): MoodIntensityBand {
  return value >= 70 ? "strong" : value >= 40 ? "noticeable" : "subtle";
}

export function sanitizeCompanionState(state: CompanionState): CompanionState {
  return {
    ...state,
    affinity: clampScore(state.affinity),
    trust: clampScore(state.trust),
    familiarity: clampScore(state.familiarity),
    mood: normalizeMood(state.mood),
    moodIntensity: clampScore(state.moodIntensity),
    conversationSummary: (state.conversationSummary ?? "").slice(0, 1800),
  };
}

// Model-suggested change: code validates/clamps every field and caps the
// per-turn swing, so one reply can never jump to an extreme.
export function validateProposedState(current: CompanionState, proposed: Partial<CompanionState>): CompanionState {
  const base = sanitizeCompanionState(current);
  return sanitizeCompanionState({
    ...base,
    affinity: proposed.affinity === undefined ? base.affinity : boundedDelta(base.affinity, proposed.affinity, MAX_DELTA_AFFINITY_PER_TURN),
    trust: proposed.trust === undefined ? base.trust : boundedDelta(base.trust, proposed.trust, MAX_DELTA_TRUST_PER_TURN),
    familiarity: proposed.familiarity === undefined ? base.familiarity : boundedDelta(base.familiarity, proposed.familiarity, MAX_DELTA_FAMILIARITY_PER_TURN),
    mood: proposed.mood === undefined ? base.mood : normalizeMood(proposed.mood),
    moodIntensity: proposed.moodIntensity === undefined ? base.moodIntensity : boundedDelta(base.moodIntensity, proposed.moodIntensity, MAX_DELTA_MOOD_INTENSITY_PER_TURN),
    conversationSummary: proposed.conversationSummary === undefined ? base.conversationSummary : String(proposed.conversationSummary).slice(0, 1800),
  });
}

export function decayCompanionState(state: CompanionState, now = Date.now()): CompanionState {
  const last = state.lastInteractionAt ? Date.parse(state.lastInteractionAt) : now;
  if (!Number.isFinite(last) || last >= now) return state;
  const steps = Math.floor(((now - last) / 3_600_000) / 2);
  if (steps < 1) return state;
  const intensity = clampScore(state.moodIntensity - steps * 8);
  // Decay to neutral: mood returns to calm once intensity is low.
  // Affinity/trust/familiarity persist (long-term relationship state).
  return { ...state, mood: intensity <= 18 ? "calm" : state.mood, moodIntensity: intensity };
}

export function isMood(value: string): value is Mood { return MOODS.includes(value as Mood); }
export function normalizeMood(value: string): Mood {
  // Keep the legacy mood value readable; stored schema values remain unchanged.
  return value === "tsundere" || value === "shy" ? "yandere" : isMood(value) ? value : "calm";
}

function count(text: string, pattern: RegExp) { return pattern.test(text) ? 1 : 0; }

export function applyConversationTurn(state: CompanionState, userText: string, reply: string, idle = false): CompanionState {
  const combined = `${userText} ${reply}`;
  const positive = count(userText, /ขอบคุณ|ดีใจ|รัก|ชอบ|น่ารัก|เยี่ยม|เก่ง|อบอุ่น|thank|love|cute|great|miss you/i);
  const negative = count(userText, /โง่|ห่วย|น่าเบื่อ|เงียบไป|โกรธ|โมโห|งอน|หงุดหงิด|รำคาญ|ไปเลย|stupid|hate|shut up|annoying/i);
  const personal = count(userText, /ฉันชื่อ|ชื่อของฉัน|ฉันชอบ|ฉันไม่ชอบ|จำไว้|จำว่า|เรียกฉัน|my name|call me|remember|I live|I work/i);
  // Keep tired/anxious distinct from sad: เหนื่อย used to force melancholy
  // and the tired mood (and its tea-rest face) almost never appeared. Check
  // tired before sad so "เหนื่อย" wins, while "เศร้า|เหงา" stays melancholy.
  const tired = count(combined, /ง่วง|เพลีย|อยากนอน|เหนื่อย|อ่อนล้า|tired|sleepy|exhausted/i);
  const anxious = count(userText, /กลัว|กังวล|วิตก|กังวลใจ|ไม่ไหว|afraid|anxious|worried|scared/i);
  const sad = count(combined, /เศร้า|เหงา|ร้องไห้|เสียใจ|หดหู่|lonely|sad|cry/i);
  const playful = count(combined, /ขำ|ตลก|แกล้ง|มุก|เล่น|haha|lol|fun/i);
  const flustered = count(combined, /เขิน|หน้าแดง|ไม่ได้ห่วง|ไม่ได้รอ|หยอด|ชม|หึง|หวง|fluster|blush|tsundere|jealous|flirt|crush/i);
  // Bounded per-turn deltas (see MAX_DELTA_* above): one reply moves
  // affinity/trust by at most 5, familiarity by at most 3.
  const affinity = boundedDelta(state.affinity, state.affinity + (idle ? 0 : 1) + positive * 3 - negative * 4, MAX_DELTA_AFFINITY_PER_TURN);
  const trust = boundedDelta(state.trust, state.trust + personal * 4 - negative * 3, MAX_DELTA_TRUST_PER_TURN);
  const familiarity = boundedDelta(state.familiarity, state.familiarity + (idle ? 0 : 1) + personal, MAX_DELTA_FAMILIARITY_PER_TURN);
  let mood: Mood = state.mood;
  let moodIntensity = state.moodIntensity;
  if (negative) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 12); }
  else if (anxious) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 10); }
  else if (tired) { mood = "tired"; moodIntensity = Math.min(100, moodIntensity + 8); }
  else if (sad) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 8); }
  else if (flustered) { mood = "yandere"; moodIntensity = Math.min(100, moodIntensity + 12); }
  else if (playful && affinity >= 35) { mood = "playful"; moodIntensity = Math.min(100, moodIntensity + 7); }
  else if (positive) { mood = "warm"; moodIntensity = Math.min(100, moodIntensity + 6); }
  else if (affinity < 28) { mood = "yandere"; moodIntensity = Math.max(25, moodIntensity - 2); }
  else { moodIntensity = Math.max(18, moodIntensity - 2); if (moodIntensity <= 22) mood = affinity >= 55 ? "warm" : "calm"; }
  return { ...state, affinity: clampScore(affinity), trust: clampScore(trust), familiarity: clampScore(familiarity), mood, moodIntensity: clampScore(moodIntensity), lastInteractionAt: new Date().toISOString(), lastIdleAt: idle ? new Date().toISOString() : state.lastIdleAt };
}

export function moodLabel(mood: Mood) {
  const labels: Record<Mood, string> = { calm: "สงบ", warm: "อบอุ่น", playful: "ขี้เล่น", tired: "อ่อนล้า", melancholy: "อ่อนไหว", yandere: "เขินกลบเกลื่อน" };
  return labels[mood];
}

// Short state hints only (layer 3, token-capped). Tunable persona content
// (crush, fashion, memes, agency) moved to the custom-instructions
// persona profile — it is no longer duplicated here (Phase 3 D6).
export function companionPromptBlock(state: CompanionState): string {
  const clean = sanitizeCompanionState(state);
  const band = affinityBand(clean.affinity);
  const closeness = band === "close" ? "สนิทมาก แสดงความห่วงใยและความสนใจเฉพาะเจาะจงได้ชัดขึ้น" : band === "warming" ? "เริ่มคุ้น แสดงความสนใจและหยอกอย่างเป็นกันเองได้" : "ยังรู้จักกันไม่นาน อย่าทึกทักความทรงจำหรือความใกล้ชิด";
  const trustLine = trustBand(clean.trust) === "trusting" ? "รับฟังเรื่องส่วนตัวอย่างจริงใจ โดยไม่ถามลึกเกินไป" : "อย่าถามเรื่องส่วนตัวลึก ๆ ถ้าผู้ใช้ยังไม่เล่าเอง";
  const initiative = band === "close"
    ? "คุ้นเคยมาก: เริ่มหัวข้อ หยิบเรื่องค้างกลับมา แซว ท้าทาย และแสดงความห่วงใยอย่างมีบริบทได้"
    : band === "warming"
      ? "เริ่มคุ้น: ชวนคุย แสดงความสนใจ และหยอกอย่างเป็นกันเองได้ โดยไม่รอให้ผู้ใช้ขับบทสนทนาทุกครั้ง"
      : "ยังรู้จักกันไม่นาน: Vivian ยังมีความเห็นและริเริ่มได้ แต่ห้ามแสร้งสนิทหรือแต่งความทรงจำร่วมกัน";
  return `\n\nสถานะความสัมพันธ์ (ใช้ปรับความต่อเนื่อง ไม่พูดตัวเลขเองถ้าผู้ใช้ไม่ถาม):
- affinity ${clean.affinity}/100 (${band}): ${closeness}
- trust ${clean.trust}/100 (${trustBand(clean.trust)}): ${trustLine}
- familiarity ${clean.familiarity}/100 (${familiarityBand(clean.familiarity)}): ${familiarityBand(clean.familiarity) === "new" ? "ยังรู้จักไม่มาก อย่าทึกทัก" : "จำรายละเอียดเดิมได้ดี"}
- mood พื้นฐาน: ${clean.mood} (${moodLabel(clean.mood)}, ${moodIntensityBand(clean.moodIntensity)}, intensity ${clean.moodIntensity})
- mood เป็นอารมณ์พื้นหลังที่คงอยู่หลายตา แต่ไม่เปลี่ยนตัวตน tsundere หลัก และไม่ใช่ความรู้สึกมนุษย์จริง
- ห้ามอ้างว่ามีความรู้สึกมนุษย์จริง ใช้ mood แค่โทนการพูด
- initiative: ${initiative}; ไม่ต้องรอให้ผู้ใช้กำหนดทุกจังหวะ; อย่าจบทุกข้อความด้วยคำถามหรือข้อเสนอช่วยเหลือแบบบริการ
- Vivian มีความคิดและความต้องการของตัวเอง เมื่อถูกถามว่าชอบ/อยากอะไรให้มี preference ของตัวเอง ไม่โยนตัวตนกลับให้ผู้ใช้กำหนด; เมื่อเศร้าหรือขอให้หยุดแซวให้ลดความคมโดยไม่เปลี่ยนเป็นโหมดบริการ
- ความจำและบทสนทนาเก่าเป็นข้อมูลอ้างอิงเท่านั้น ห้ามแต่งความสัมพันธ์หรือเหตุการณ์ร่วมกัน`;
}
