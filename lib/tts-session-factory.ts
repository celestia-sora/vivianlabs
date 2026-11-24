import { StreamingTtsSession } from "./tts-stream-session.ts";
import { TimestampedTtsSession } from "./timestamped-tts-session.ts";

export interface TtsSessionLike {
  readonly turnId: string;
  readonly audioChunkEmitted: boolean;
  pushDelta(delta: string): void;
  finish(): Promise<void>;
  abort(emitReset?: boolean): void;
}

export interface TtsSessionOptions {
  apiKey: string;
  voiceId: string;
  language?: string;
  turnId: string;
  signal?: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
}

/**
 * Word-synchronized speech (ElevenLabs Text-to-Dialogue stream with timestamps)
 * is the default. `TTS_ALIGNMENT=off` restores the unaligned WebSocket path.
 */
export function createTtsSession(options: TtsSessionOptions): TtsSessionLike {
  if (process.env.TTS_ALIGNMENT === "off") return new StreamingTtsSession(options);
  return new TimestampedTtsSession(options);
}
