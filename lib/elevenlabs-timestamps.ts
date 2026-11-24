import { STREAM_OUTPUT_FORMAT, STREAM_SAMPLE_RATE, AUDIO_STREAM_CONFIG } from "./audio-stream-config.ts";
import { elevenLabsLanguageParam, normalizeSpeechLanguage } from "./elevenlabs-voice.ts";

export const ELEVENLABS_TTD_STREAM_TIMESTAMPS_URL = "https://api.elevenlabs.io/v1/text-to-dialogue/stream/with-timestamps";

export interface TimestampedMessage {
  /** Base64 PCM16 audio carried by this message (may be empty). */
  audio: string;
  /** Raw ElevenLabs `alignment` object for the message, if present. */
  alignment: unknown;
}

export interface TimestampStreamOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  language?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TimestampStreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TimestampStreamError";
    this.status = status;
  }
}

/** Parses a text buffer of newline-delimited JSON objects; returns messages and the unparsed tail. */
export function parseTimestampLines(buffer: string): { messages: TimestampedMessage[]; rest: string } {
  const messages: TimestampedMessage[] = [];
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let json: unknown;
    try { json = JSON.parse(trimmed); } catch { continue; }
    const m = toMessage(json);
    if (m) messages.push(m);
  }
  return { messages, rest };
}

function toMessage(json: unknown): TimestampedMessage | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const audio = typeof o.audio_base64 === "string" ? o.audio_base64 : "";
  const alignment = o.alignment ?? null;
  if (!audio && !alignment) return null;
  return { audio, alignment };
}

/**
 * Streams one phrase from ElevenLabs Text-to-Dialogue (eleven_v4) with
 * character alignment, yielding each message as it arrives.
 */
export async function* streamDialogueWithTimestamps(options: TimestampStreamOptions): AsyncGenerator<TimestampedMessage> {
  const doFetch = options.fetchImpl ?? fetch;
  const language = normalizeSpeechLanguage(options.language);
  const langParam = elevenLabsLanguageParam(language);
  const url = `${ELEVENLABS_TTD_STREAM_TIMESTAMPS_URL}?output_format=${STREAM_OUTPUT_FORMAT}`;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 20_000)];
  if (options.signal) signals.push(options.signal);
  const response = await doFetch(url, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.any(signals),
    body: JSON.stringify({
      inputs: [{ text: options.text, voice_id: options.voiceId }],
      model_id: AUDIO_STREAM_CONFIG.modelId,
      ...(langParam ? { language_code: langParam } : {}),
      apply_text_normalization: "auto",
    }),
  });
  if (!response.ok || !response.body) {
    throw new TimestampStreamError(`ElevenLabs timestamp stream failed (${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      const parsed = parseTimestampLines(done ? `${buffer}\n` : buffer);
      buffer = parsed.rest;
      for (const m of parsed.messages) yield m;
      if (done) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

export { STREAM_SAMPLE_RATE };
