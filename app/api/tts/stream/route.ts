import { NextResponse } from "next/server";
import { requireApiAccess } from "@/lib/auth/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { speechText, speechTextWithAudioTags } from "@/lib/speech";
import { normalizeSpeechLanguage, resolveElevenLabsVoiceId } from "@/lib/elevenlabs-voice";
import { StreamingTtsSession } from "@/lib/tts-stream-session";

export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const quota = rateLimit(request, "tts", 30);
  if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY is not configured" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", status: 400 }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Text is required", status: 400 }, { status: 400 });
  }

  const { text, language, voiceId: reqVoiceId, turnId: reqTurnId } = body as Record<string, unknown>;
  if (typeof text !== "string" || text.length > 5000) {
    return NextResponse.json(
      { error: "Text is required and must be under 5000 characters", status: 400 },
      { status: 400 },
    );
  }

  const effectiveVoiceId = await resolveElevenLabsVoiceId(reqVoiceId);
  if (!effectiveVoiceId) {
    return NextResponse.json(
      { error: "ELEVENLABS_VOICE_ID is not configured and no voiceId provided", status: 500 },
      { status: 500 },
    );
  }

  const speechLanguage = normalizeSpeechLanguage(language);
  const cleanText = speechText(text, speechLanguage);
  const taggedText = speechTextWithAudioTags(text, speechLanguage);
  if (!cleanText) {
    return NextResponse.json({ error: "Text must contain spoken words", status: 400 }, { status: 400 });
  }
  if (cleanText.length > 2000 || taggedText.length > 2000) {
    return NextResponse.json(
      { error: "Prepared speech must be under 2000 characters for ElevenLabs v4", status: 400 },
      { status: 400 },
    );
  }

  const turnId =
    typeof reqTurnId === "string" && reqTurnId.trim()
      ? reqTurnId.trim().slice(0, 64)
      : crypto.randomUUID();

  let session: StreamingTtsSession | null = null;
  let cancelled = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        if (!cancelled) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      };

      session = new StreamingTtsSession({
        apiKey,
        voiceId: effectiveVoiceId,
        language: speechLanguage,
        turnId,
        signal: request.signal,
        emit,
      });

      try {
        session.pushDelta(text);
        await session.finish();
      } catch {
        // Error events are emitted by StreamingTtsSession callbacks; abort is silent.
      } finally {
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      session?.abort(false);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
