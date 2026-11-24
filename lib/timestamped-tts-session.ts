import { AlignmentAccumulator, pcm16DurationSec } from "./kinetic/alignment.ts";
import { STREAM_OUTPUT_FORMAT, STREAM_SAMPLE_RATE } from "./audio-stream-config.ts";
import { streamDialogueWithTimestamps, type TimestampedMessage } from "./elevenlabs-timestamps.ts";
import { TtsTextBuffer, type TtsPhraseSegment } from "./tts-text-buffer.ts";

export type TimestampStreamFn = (options: {
  apiKey: string;
  voiceId: string;
  text: string;
  language?: string;
  signal?: AbortSignal;
}) => AsyncIterable<TimestampedMessage>;

export interface TimestampedTtsSessionOptions {
  apiKey: string;
  voiceId: string;
  language?: string;
  turnId: string;
  signal?: AbortSignal;
  emit: (event: Record<string, unknown>) => void;
  /** Injection point for tests. */
  stream?: TimestampStreamFn;
  /** Phrases fetched ahead of playback emission (default 2). */
  concurrency?: number;
}

interface Job {
  index: number;
  phrase: TtsPhraseSegment;
  acc: AlignmentAccumulator;
  buffered: Array<{ audio: Buffer | null; audioBase64: string; chars: ReturnType<AlignmentAccumulator["push"]>; duration: number }>;
  live: boolean;
  done: boolean;
  error: Error | null;
}

function decodeBase64(b64: string): Buffer | null {
  const cleaned = b64.replace(/\s+/g, "");
  if (!cleaned) return null;
  const bytes = Buffer.from(cleaned, "base64");
  return bytes.byteLength > 0 ? bytes : null;
}

/**
 * Drop-in alternative to `StreamingTtsSession` that synthesizes each phrase via
 * Text-to-Dialogue `stream/with-timestamps` and emits `audio_alignment` events
 * on the turn's continuous audio timeline next to the usual `audio_chunk`s.
 *
 * Phrases are fetched with limited concurrency but emitted strictly in order;
 * later phrases buffer until earlier ones finish so timeline offsets (the audio
 * seconds already emitted) are exact.
 */
export class TimestampedTtsSession {
  readonly turnId: string;
  private readonly o: TimestampedTtsSessionOptions;
  private readonly buffer: TtsTextBuffer;
  private readonly jobs: Job[] = [];
  private readonly controller = new AbortController();
  private seq = 0;
  private turnOffsetSec = 0;
  private headIndex = 0;
  private running = 0;
  private nextToStart = 0;
  private finishing = false;
  private _audioChunkEmitted = false;
  private _aborted = false;
  private startedAt = Date.now();
  private firstAudioAt: number | null = null;
  private fatal = false;
  private waiters: Array<() => void> = [];

  constructor(options: TimestampedTtsSessionOptions) {
    this.o = options;
    this.turnId = options.turnId;
    this.buffer = new TtsTextBuffer({ language: options.language });
    options.signal?.addEventListener("abort", () => this.abort(false), { once: true });
  }

  get audioChunkEmitted(): boolean { return this._audioChunkEmitted; }

  pushDelta(delta: string): void {
    if (this._aborted || !delta) return;
    for (const phrase of this.buffer.push(delta)) this.enqueue(phrase);
  }

  async finish(): Promise<void> {
    if (this._aborted) return;
    for (const phrase of this.buffer.finish()) this.enqueue(phrase);
    this.finishing = true;
    this.pump();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this._aborted || this.fatal || (this.headIndex >= this.jobs.length && this.running === 0)) {
          this.complete();
          resolve();
        } else this.waiters.push(check);
      };
      check();
    });
  }

  abort(emitReset = true): void {
    if (this._aborted) return;
    this._aborted = true;
    this.controller.abort();
    if (emitReset && this._audioChunkEmitted) this.o.emit({ event: "audio_reset", turnId: this.turnId });
    this.wake();
  }

  private completed = false;
  private complete(): void {
    if (this.completed || this._aborted || this.fatal) return;
    this.completed = true;
    this.o.emit({
      event: "audio_turn_end",
      turnId: this.turnId,
      chunkCount: this.seq,
      ttfbMs: this.firstAudioAt === null ? null : this.firstAudioAt - this.startedAt,
      totalDurationMs: Date.now() - this.startedAt,
    });
  }

  private wake(): void {
    const w = this.waiters.splice(0, this.waiters.length);
    for (const fn of w) fn();
  }

  private enqueue(phrase: TtsPhraseSegment): void {
    if (!phrase.taggedText.trim()) return;
    this.jobs.push({ index: this.jobs.length, phrase, acc: new AlignmentAccumulator(0), buffered: [], live: false, done: false, error: null });
    this.pump();
  }

  private pump(): void {
    if (this._aborted || this.fatal) return;
    const limit = this.o.concurrency ?? 2;
    while (this.running < limit && this.nextToStart < this.jobs.length) {
      const job = this.jobs[this.nextToStart++];
      this.running += 1;
      void this.runJob(job).finally(() => { this.running -= 1; this.advance(); this.pump(); this.wake(); });
    }
    this.advance();
  }

  private async runJob(job: Job): Promise<void> {
    const stream = this.o.stream ?? ((opts) => streamDialogueWithTimestamps(opts));
    try {
      const iterator = stream({
        apiKey: this.o.apiKey,
        voiceId: this.o.voiceId,
        text: job.phrase.taggedText,
        language: this.o.language,
        signal: this.controller.signal,
      });
      for await (const msg of iterator) {
        if (this._aborted) return;
        const bytes = decodeBase64(msg.audio);
        const duration = bytes ? pcm16DurationSec(bytes.byteLength - (bytes.byteLength % 2), STREAM_SAMPLE_RATE) : 0;
        const chars = job.acc.push(msg.alignment, duration);
        job.buffered.push({ audio: bytes, audioBase64: msg.audio, chars, duration });
        this.advance();
      }
    } catch (error) {
      if (this._aborted) return;
      job.error = error instanceof Error ? error : new Error("Timestamp stream failed");
    } finally {
      job.done = true;
    }
  }

  /** Emits buffered output for the head job, moving on when it completes. */
  private advance(): void {
    if (this._aborted || this.fatal) return;
    for (;;) {
      const job = this.jobs[this.headIndex];
      if (!job) return;
      job.live = true;
      const items = job.buffered.splice(0, job.buffered.length);
      for (const item of items) this.emitItem(job, item);
      if (!job.done) return;
      if (job.error) {
        this.fatal = true;
        this.o.emit({
          event: "audio_error",
          turnId: this.turnId,
          code: "TTS_TIMESTAMP_STREAM_FAILED",
          error: job.error.message,
          audioStarted: this._audioChunkEmitted,
        });
        this.wake();
        return;
      }
      this.o.emit({ event: "audio_alignment_end", turnId: this.turnId, sentence: job.index });
      this.turnOffsetSec += job.acc.audioDurationSec;
      this.headIndex += 1;
    }
  }

  private emitItem(job: Job, item: Job["buffered"][number]): void {
    if (item.audio) {
      const seq = this.seq++;
      this._audioChunkEmitted = true;
      if (this.firstAudioAt === null) this.firstAudioAt = Date.now();
      this.o.emit({
        event: "audio_chunk",
        turnId: this.turnId,
        seq,
        audio: item.audioBase64.replace(/\s+/g, ""),
        format: STREAM_OUTPUT_FORMAT,
        sampleRate: STREAM_SAMPLE_RATE,
      });
    }
    if (item.chars.length > 0) {
      const off = this.turnOffsetSec;
      this.o.emit({
        event: "audio_alignment",
        turnId: this.turnId,
        sentence: job.index,
        chars: item.chars.map((c) => c.char),
        starts: item.chars.map((c) => +(c.start + off).toFixed(4)),
        ends: item.chars.map((c) => +(c.end + off).toFixed(4)),
      });
    }
  }
}
