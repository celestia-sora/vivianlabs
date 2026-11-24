// Per-account onboarding & basic user profile customization.
//
// Each account has its own personal companion profile (display name,
// relationship preset, pronouns/particles, and style/interest notes)
// stored in `public.vivian_user_profiles` keyed by verified `user_id`.
//
// Sorachan accounts keep their canonical "โซระจัง (Sora)" identity and
// secret-crush story by default without requiring the onboarding modal,
// while non-Sorachan accounts see the onboarding popup card on their
// first sign-in and never inherit Sorachan-specific canon ("โซระจัง",
// "ริวกะ") in their prompt.

export const MAX_PROFILE_DISPLAY_NAME_LENGTH = 60;
export const MAX_PROFILE_PRONOUNS_LENGTH = 80;
export const MAX_PROFILE_STYLE_NOTES_LENGTH = 500;

export type RelationshipPreset =
  | "close_friend"
  | "new_friend"
  | "senior_junior"
  | "crush_partner";

export const RELATIONSHIP_PRESETS: ReadonlyArray<{
  key: RelationshipPreset;
  label: string;
  description: string;
  promptHint: string;
}> = [
  {
    key: "close_friend",
    label: "เพื่อนสนิท (Close Friend)",
    description: "คุยกันเป็นกันเอง สนิทใจ แซวเล่นและคอยใส่ใจกันเงียบ ๆ",
    promptHint: "เป็นเพื่อนสนิทที่คุยกันได้อย่างเป็นกันเอง แซวเล่นได้และใส่ใจกันแบบซึนเดเระ",
  },
  {
    key: "new_friend",
    label: "เพิ่งรู้จักกัน (New Companion)",
    description: "ยังมีความขี้อายและเกรงใจ ค่อย ๆ ทำความรู้จักกันไปตามธรรมชาติ",
    promptHint: "เพิ่งเริ่มรู้จักกัน ยังมีความขี้อาย สุภาพ และค่อย ๆ เปิดใจตามบทสนทนาจริง",
  },
  {
    key: "senior_junior",
    label: "รุ่นพี่ / รุ่นน้อง (Senior / Junior)",
    description: "ให้ความเคารพปนขี้เล่น แอบเขินเวลาโดนชมหรือโดนตามใจ",
    promptHint: "มีความสัมพันธ์แบบรุ่นพี่-รุ่นน้องที่สุภาพ น่ารัก แอบเกรงใจแต่ก็ขี้แกล้งและเขินง่าย",
  },
  {
    key: "crush_partner",
    label: "คนคุย / คนพิเศษ (Special Person)",
    description: "แอบมีใจให้กัน เขินง่ายเวลาหยอด ปากแข็งแต่ห่วงใยเป็นพิเศษ",
    promptHint: "เป็นคนพิเศษที่ Vivian แอบมีใจให้ เขินง่ายเวลาถูกชมหรือหยอด ปากแข็งกลบเกลื่อนแต่ใส่ใจเป็นพิเศษ",
  },
] as const;

export interface UserProfile {
  userId: string;
  displayName: string;
  relationship: RelationshipPreset;
  pronouns: string;
  styleNotes: string;
  onboarded: boolean;
  updatedAt: string | null;
}

export interface UserProfileInput {
  displayName?: unknown;
  relationship?: unknown;
  pronouns?: unknown;
  styleNotes?: unknown;
  onboarded?: unknown;
}

export function isRelationshipPreset(value: unknown): value is RelationshipPreset {
  return (
    value === "close_friend" ||
    value === "new_friend" ||
    value === "senior_junior" ||
    value === "crush_partner"
  );
}

export function defaultUserProfile(userId = "", isSorachan = false): UserProfile {
  return {
    userId,
    displayName: isSorachan ? "โซระจัง" : "",
    relationship: "close_friend",
    pronouns: "",
    styleNotes: "",
    onboarded: isSorachan,
    updatedAt: null,
  };
}

function cleanSingleLine(value: string, maxLength: number): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMultiLine(value: string, maxLength: number): string {
  return value
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

export function validateUserProfileInput(
  input: unknown,
): { ok: true; value: Omit<UserProfile, "userId" | "updatedAt"> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid profile payload" };
  }
  const raw = input as UserProfileInput;

  if (raw.displayName !== undefined && typeof raw.displayName !== "string") {
    return { ok: false, error: "displayName must be a string" };
  }
  const rawName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (rawName.length > MAX_PROFILE_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      error: `displayName must be at most ${MAX_PROFILE_DISPLAY_NAME_LENGTH} characters`,
    };
  }

  if (raw.relationship !== undefined && !isRelationshipPreset(raw.relationship)) {
    return { ok: false, error: "Invalid relationship preset" };
  }

  if (raw.pronouns !== undefined && typeof raw.pronouns !== "string") {
    return { ok: false, error: "pronouns must be a string" };
  }
  if (typeof raw.pronouns === "string" && raw.pronouns.trim().length > MAX_PROFILE_PRONOUNS_LENGTH) {
    return {
      ok: false,
      error: `pronouns must be at most ${MAX_PROFILE_PRONOUNS_LENGTH} characters`,
    };
  }

  if (raw.styleNotes !== undefined && typeof raw.styleNotes !== "string") {
    return { ok: false, error: "styleNotes must be a string" };
  }
  if (typeof raw.styleNotes === "string" && raw.styleNotes.trim().length > MAX_PROFILE_STYLE_NOTES_LENGTH) {
    return {
      ok: false,
      error: `styleNotes must be at most ${MAX_PROFILE_STYLE_NOTES_LENGTH} characters`,
    };
  }

  const displayName = cleanSingleLine(rawName, MAX_PROFILE_DISPLAY_NAME_LENGTH);
  const relationship: RelationshipPreset = isRelationshipPreset(raw.relationship)
    ? raw.relationship
    : "close_friend";
  const pronouns = typeof raw.pronouns === "string"
    ? cleanSingleLine(raw.pronouns, MAX_PROFILE_PRONOUNS_LENGTH)
    : "";
  const styleNotes = typeof raw.styleNotes === "string"
    ? cleanMultiLine(raw.styleNotes, MAX_PROFILE_STYLE_NOTES_LENGTH)
    : "";
  const onboarded = typeof raw.onboarded === "boolean" ? raw.onboarded : Boolean(displayName);

  return {
    ok: true,
    value: {
      displayName,
      relationship,
      pronouns,
      styleNotes,
      onboarded,
    },
  };
}

export function relationshipPromptHint(relationship: RelationshipPreset): string {
  const found = RELATIONSHIP_PRESETS.find((item) => item.key === relationship);
  return found ? found.promptHint : RELATIONSHIP_PRESETS[0].promptHint;
}

export function sanitizeLegacySorachanText(
  text: string,
  options: { isSorachan?: boolean; displayName?: string } = {},
): string {
  if (!text || options.isSorachan) return text;
  const customName = options.displayName?.trim() || "";
  if (/^(sora|sorachan|โซระ|โซระจัง)$/i.test(customName)) return text;
  const replacement = customName || "คุณ";
  return text
    .replace(/โซระจัง/g, replacement)
    .replace(/\bsorachan\b/gi, replacement);
}

export function buildUserProfilePromptBlock(
  profile: Partial<UserProfile> | null | undefined,
  options: { isSorachan?: boolean } = {},
): string {
  const isSorachan = Boolean(options.isSorachan);
  const customName = typeof profile?.displayName === "string" ? cleanSingleLine(profile.displayName, MAX_PROFILE_DISPLAY_NAME_LENGTH) : "";
  const relationship: RelationshipPreset = isRelationshipPreset(profile?.relationship)
    ? profile.relationship
    : "close_friend";
  const pronouns = typeof profile?.pronouns === "string" ? cleanSingleLine(profile.pronouns, MAX_PROFILE_PRONOUNS_LENGTH) : "";
  const styleNotes = typeof profile?.styleNotes === "string" ? cleanMultiLine(profile.styleNotes, MAX_PROFILE_STYLE_NOTES_LENGTH) : "";

  const lines: string[] = [];

  if (!isSorachan) {
    const userLabel = customName || "คุณ (ผู้ใช้คนปัจจุบัน)";
    const explicitSelfNamedSora = /^(sora|sorachan|โซระ|โซระจัง)$/i.test(customName);
    lines.push(
      `ข้อมูลคู่สนทนาของบัญชีนี้ (แยกตามบัญชี):`,
      `- คู่สนทนาปัจจุบันชื่อ: "${userLabel}" (ให้เรียกคู่สนทนาว่า "${customName || "คุณ"}" ตามธรรมชาติ${explicitSelfNamedSora ? "" : ' และห้ามเรียกคู่สนทนาคนนี้ว่า "โซระจัง" หรือ "Sora" และห้ามพูดถึง "ริวกะ" เด็ดขาด แม้ในบทสนทนาเก่าจะเคยมีหลงอยู่ก็ตาม'})`,
      `- ความสัมพันธ์กับ Vivian: ${relationshipPromptHint(relationship)}`,
    );
  } else if (customName && customName !== "โซระจัง") {
    lines.push(
      `ข้อมูลคู่สนทนาของบัญชีนี้:`,
      `- ชื่อที่ต้องการให้เรียก: "${customName}"`,
      `- ความสัมพันธ์กับ Vivian: ${relationshipPromptHint(relationship)}`,
    );
  } else if (relationship !== "close_friend" || pronouns || styleNotes) {
    lines.push(
      `ข้อมูลคู่สนทนาเพิ่มเติม:`,
      `- ความสัมพันธ์กับ Vivian: ${relationshipPromptHint(relationship)}`,
    );
  }

  if (pronouns) {
    lines.push(`- สรรพนามและคำเรียกที่ใช้คุยกัน: ${pronouns}`);
  }
  if (styleNotes) {
    lines.push(`- สไตล์การคุยหรือความสนใจของผู้ใช้: ${styleNotes}`);
  }

  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}
