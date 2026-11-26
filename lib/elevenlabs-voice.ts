import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin.ts";

export type ElevenLabsLanguageCode = "global" | "th" | "en" | "ja" | "ko" | "zh";

export function normalizeSpeechLanguage(language: unknown): ElevenLabsLanguageCode {
  return language === "global" ||
    language === "en" ||
    language === "ja" ||
    language === "ko" ||
    language === "zh" ||
    language === "th"
    ? language
    : "global";
}

export function elevenLabsLanguageParam(language: ElevenLabsLanguageCode): string | undefined {
  if (language === "th" || language === "en" || language === "ja" || language === "ko" || language === "zh") {
    return language;
  }
  return undefined;
}

export async function resolveElevenLabsVoiceId(
  reqVoiceId?: unknown,
  userId = "global",
  dbClient?: SupabaseClient,
  allowCustomVoice = true,
): Promise<string> {
  if (!allowCustomVoice) {
    return (process.env.ELEVENLABS_VOICE_ID ?? "").trim();
  }

  let effectiveVoiceId =
    typeof reqVoiceId === "string" && reqVoiceId.trim() ? reqVoiceId.trim() : "";

  const ownerId = typeof userId === "string" && userId.trim() ? userId.trim() : "global";

  if (!effectiveVoiceId) {
    try {
      const db = dbClient ?? getSupabaseAdmin(AbortSignal.timeout(3000));
      const res = await db
        .from("vivian_voice_preferences")
        .select("voice_id")
        .eq("id", ownerId)
        .maybeSingle();
      if (res.data?.voice_id && typeof res.data.voice_id === "string") {
        effectiveVoiceId = res.data.voice_id.trim();
      }
    } catch {
      // Fallback to env
    }
  }

  if (!effectiveVoiceId) {
    effectiveVoiceId = (process.env.ELEVENLABS_VOICE_ID ?? "").trim();
  }

  return effectiveVoiceId;
}

const VOICE_COLUMNS = "voice_id,speech_language,speaking_speed";
const VOICE_COLUMNS_FALLBACK = "speech_language,speaking_speed";

export interface UserVoicePreferences {
  voiceId: string;
  defaultVoiceId: string;
  speechLanguage: ElevenLabsLanguageCode;
  speakingSpeed?: number;
}

export async function getVoicePreferences(
  db: SupabaseClient,
  userId: string,
  defaultEnvVoiceId = (process.env.ELEVENLABS_VOICE_ID ?? "").trim(),
): Promise<UserVoicePreferences> {
  const ownerId = userId.trim();
  if (!ownerId) throw new Error("A user identity is required");

  let result = await db
    .from("vivian_voice_preferences")
    .select(VOICE_COLUMNS)
    .eq("id", ownerId)
    .maybeSingle();

  if (result.error && /voice_id/i.test(result.error.message)) {
    result = await db
      .from("vivian_voice_preferences")
      .select(VOICE_COLUMNS_FALLBACK)
      .eq("id", ownerId)
      .maybeSingle();
  }

  if (result.error) throw result.error;

  const row = result.data as { voice_id?: unknown; speech_language?: unknown; speaking_speed?: unknown } | null;
  const savedVoiceId =
    typeof row?.voice_id === "string" && row.voice_id.trim() ? row.voice_id.trim() : defaultEnvVoiceId;
  const savedLang = normalizeSpeechLanguage(row?.speech_language ?? "th");
  const savedSpeed = typeof row?.speaking_speed === "number" ? row.speaking_speed : undefined;

  return {
    voiceId: savedVoiceId,
    defaultVoiceId: defaultEnvVoiceId,
    speechLanguage: savedLang === "global" && row?.speech_language === undefined ? "th" : savedLang,
    ...(savedSpeed !== undefined ? { speakingSpeed: savedSpeed } : {}),
  };
}

export async function saveVoicePreferences(
  db: SupabaseClient,
  userId: string,
  patch: { voiceId?: string; speechLanguage?: ElevenLabsLanguageCode },
  defaultEnvVoiceId = (process.env.ELEVENLABS_VOICE_ID ?? "").trim(),
): Promise<UserVoicePreferences> {
  const ownerId = userId.trim();
  if (!ownerId) throw new Error("A user identity is required");

  const row: Record<string, unknown> = {
    id: ownerId,
    ...(patch.voiceId === undefined ? {} : { voice_id: patch.voiceId.trim() }),
    ...(patch.speechLanguage === undefined ? {} : { speech_language: patch.speechLanguage }),
    updated_at: new Date().toISOString(),
  };

  let result = await db
    .from("vivian_voice_preferences")
    .upsert(row, { onConflict: "id" })
    .select(VOICE_COLUMNS)
    .single();

  if (result.error && /voice_id/i.test(result.error.message)) {
    const fallbackRow = { ...row };
    delete fallbackRow.voice_id;
    result = await db
      .from("vivian_voice_preferences")
      .upsert(fallbackRow, { onConflict: "id" })
      .select(VOICE_COLUMNS_FALLBACK)
      .single();
  }

  if (result.error) throw result.error;

  const data = result.data as { voice_id?: unknown; speech_language?: unknown; speaking_speed?: unknown } | null;
  const savedVoiceId =
    typeof data?.voice_id === "string" && data.voice_id.trim()
      ? data.voice_id.trim()
      : (patch.voiceId?.trim() ?? defaultEnvVoiceId);
  const savedLang =
    typeof data?.speech_language === "string"
      ? normalizeSpeechLanguage(data.speech_language)
      : (patch.speechLanguage ?? "th");
  const savedSpeed = typeof data?.speaking_speed === "number" ? data.speaking_speed : undefined;

  return {
    voiceId: savedVoiceId,
    defaultVoiceId: defaultEnvVoiceId,
    speechLanguage: savedLang,
    ...(savedSpeed !== undefined ? { speakingSpeed: savedSpeed } : {}),
  };
}
