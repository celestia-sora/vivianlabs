import {
  ElevenLabsDialogueTurn,
  type ElevenLabsDialoguePool,
  type WebSocketFactory,
} from "./elevenlabs-ws.ts";
import { TtsTextBuffer } from "./tts-text-buffer.ts";

export interface StreamingTtsSessionOptions {
  apiKey: string;
  voiceId: string;
  language?: string;
  turnId: string;
  signal?: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
  createWebSocket?: WebSocketFactory;
  pool?: ElevenLabsDialoguePool;
}

export class StreamingTtsSession {
  readonly turnId: string;
  private readonly emit: (event: Record<string, unknown>) => void;
  private readonly buffer: TtsTextBuffer;
  private readonly turn: ElevenLabsDialogueTurn;
  private _audioChunkEmitted = false;
  private _aborted = false;

  constructor(options: StreamingTtsSessionOptions) {
    this.turnId = options.turnId;
    this.emit = options.emit;
    this.buffer = new TtsTextBuffer({ language: options.language });
    this.turn = new ElevenLabsDialogueTurn(
      {
        apiKey: options.apiKey,
        voiceId: options.voiceId,
        language: options.language,
        turnId: options.turnId,
        signal: options.signal,
        createWebSocket: options.createWebSocket,
        pool: options.pool,
      },
      {
        onAudioChunk: (chunk) => {
          if (this._aborted) return;
          this._audioChunkEmitted = true;
          this.emit({
            event: "audio_chunk",
            turnId: chunk.turnId,
            seq: chunk.seq,
            audio: chunk.audio,
            format: chunk.format,
            sampleRate: chunk.sampleRate,
          });
        },
        onTurnEnd: (metrics) => {
          if (this._aborted) return;
          this.emit({
            event: "audio_turn_end",
            turnId: metrics.turnId,
            chunkCount: metrics.chunkCount,
            ttfbMs: metrics.ttfbMs,
            totalDurationMs: metrics.totalDurationMs,
          });
        },
        onError: (err) => {
          if (this._aborted) return;
          this.emit({
            event: "audio_error",
            turnId: err.turnId,
            code: err.code,
            error: err.message,
            audioStarted: err.audioStarted,
          });
        },
      },
    );
    this.turn.warmup();
  }

  get audioChunkEmitted(): boolean {
    return this._audioChunkEmitted;
  }

  pushDelta(delta: string): void {
    if (this._aborted || !delta) return;
    const phrases = this.buffer.push(delta);
    for (const phrase of phrases) {
      this.turn.sendPhrase(phrase.taggedText, phrase.flush);
    }
  }

  async finish(): Promise<void> {
    if (this._aborted) return;
    const remaining = this.buffer.finish();
    for (const phrase of remaining) {
      this.turn.sendPhrase(phrase.taggedText, phrase.flush);
    }
    await this.turn.finish();
  }

  abort(emitReset = true): void {
    if (this._aborted) return;
    this._aborted = true;
    this.turn.abort();
    if (emitReset && this._audioChunkEmitted) {
      this.emit({
        event: "audio_reset",
        turnId: this.turnId,
      });
    }
  }
}
