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

export async function resolveElevenLabsVoiceId(reqVoiceId?: unknown): Promise<string> {
  let effectiveVoiceId =
    typeof reqVoiceId === "string" && reqVoiceId.trim() ? reqVoiceId.trim() : "";

  if (!effectiveVoiceId) {
    try {
      const db = getSupabaseAdmin(AbortSignal.timeout(3000));
      const res = await db
        .from("vivian_voice_preferences")
        .select("voice_id")
        .eq("id", "global")
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
