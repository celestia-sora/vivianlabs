import { requireAuthorizedUser } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  getVoicePreferences,
  saveVoicePreferences,
  type ElevenLabsLanguageCode,
} from "@/lib/elevenlabs-voice";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_SPEECH_LANGUAGE,
  validSpeechLanguage,
} from "@/lib/voice-preferences";

const headers = { "Cache-Control": "private, no-store" };

export async function preferences(request: Request, write: boolean): Promise<Response> {
  const { user, denied } = await requireAuthorizedUser(request);
  if (denied) return denied;

  const defaultEnvVoiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  let voiceId: string | undefined;
  let language: ElevenLabsLanguageCode | undefined;

  if (write) {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid voice preferences" }, { status: 400, headers });
    }
    const record = body as Record<string, unknown>;
    const hasVoice = typeof record.voiceId === "string";
    const hasLang = validSpeechLanguage(record.speechLanguage);

    if (!hasVoice && !hasLang) {
      return Response.json({ error: "Provide a valid voiceId (string) or speechLanguage" }, { status: 400, headers });
    }
    if (hasVoice) voiceId = (record.voiceId as string).trim();
    if (hasLang) language = record.speechLanguage as ElevenLabsLanguageCode;
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const prefs = write
      ? await saveVoicePreferences(db, user.id, { voiceId, speechLanguage: language }, defaultEnvVoiceId)
      : await getVoicePreferences(db, user.id, defaultEnvVoiceId);

    return Response.json(prefs, { headers });
  } catch {
    if (write) {
      return Response.json({ error: "Could not reach database" }, { status: 503, headers });
    }
    return Response.json({
      voiceId: voiceId ?? defaultEnvVoiceId,
      defaultVoiceId: defaultEnvVoiceId,
      speechLanguage: language ?? DEFAULT_SPEECH_LANGUAGE,
    }, { headers });
  }
}

export const GET = (request: Request) => preferences(request, false);
export const PATCH = (request: Request) => preferences(request, true);
