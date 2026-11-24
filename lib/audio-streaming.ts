import { STREAM_SAMPLE_RATE, type AudioStreamMetrics } from "./audio-stream-config.ts";

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createGain(): GainNodeLike;
  createAnalyser(): AnalyserNodeLike;
}

export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainNodeLike {
  gain: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface AnalyserNodeLike {
  fftSize: number;
  smoothingTimeConstant: number;
  readonly frequencyBinCount: number;
  connect(destination: unknown): void;
  disconnect(): void;
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void;
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
}

export interface AudioStreamingManagerCallbacks {
  onPlaybackStart?: (turnId: string, metrics: AudioStreamMetrics) => void;
  onPlaybackEnd?: (metrics: AudioStreamMetrics) => void;
  onError?: (turnId: string, error: Error, audioStarted: boolean) => void;
  onInterrupt?: (metrics: AudioStreamMetrics) => void;
}

interface DecodedPcmChunk {
  seq: number;
  bytes: Uint8Array;
  sampleRate: number;
}

const INITIAL_LEAD_SEC = 0.035;
const UNDERRUN_RESUME_LEAD_SEC = 0.015;
const MIN_INITIAL_BYTES = 1920; // ~40ms at 24kHz S16LE mono

export function decodeBase64ToBytes(base64: string): Uint8Array | null {
  const cleaned = base64.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return null;
  }
  try {
    if (typeof atob === "function") {
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes.byteLength > 0 ? bytes : null;
    }
    const buf = Buffer.from(cleaned, "base64");
    return buf.byteLength > 0 ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  } catch {
    return null;
  }
}

export function pcm16LeToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const float32 = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

export class AudioStreamingManager {
  private context: AudioContextLike | null = null;
  private gainNode: GainNodeLike | null = null;
  private analyserNode: AnalyserNodeLike | null = null;
  private readonly callbacks: AudioStreamingManagerCallbacks;

  private activeBaseTurnId: string | null = null;
  private activeAttemptTurnId: string | null = null;
  private rejectedAttemptIds = new Set<string>();
  private turnStartedAt = 0;

  private expectedSeq = 0;
  private reorderBuffer = new Map<number, DecodedPcmChunk>();
  private preBufferBytes: Uint8Array[] = [];
  private preBufferedByteCount = 0;
  private pendingOddByte: number | null = null;

  private activeSources = new Set<AudioBufferSourceNodeLike>();
  private nextStartTime = 0;
  private timeline: Array<{ ctxStart: number; contentStart: number; duration: number }> = [];
  private contentCursor = 0;
  private playbackSchedulingStarted = false;
  private playbackStarted = false;
  private streamEnded = false;
  private firstChunkReceived = false;
  private lastTurnOutcome: "idle" | "active" | "started" | "completed" | "failed" | "interrupted" = "idle";
  private scheduleChain: Promise<void> = Promise.resolve();

  private metrics: AudioStreamMetrics = this.emptyMetrics("");
  private lastMetrics: AudioStreamMetrics | null = null;

  private resolveFirstAudio: ((result: { started: boolean; interrupted: boolean }) => void) | null = null;
  private resolveTurnDone: ((metrics: AudioStreamMetrics) => void) | null = null;

  constructor(callbacks: AudioStreamingManagerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  setContext(context: AudioContextLike | null): void {
    if (this.context === context) return;
    this.teardownGraph();
    this.context = context;
  }

  getContext(): AudioContextLike | null {
    return this.context;
  }

  getAnalyser(): AnalyserNodeLike | null {
    return this.analyserNode;
  }

  isPlaying(): boolean {
    return this.activeBaseTurnId !== null && this.playbackStarted && this.activeSources.size > 0;
  }

  hasStartedPlayback(): boolean {
    return this.playbackStarted;
  }

  getMetrics(): AudioStreamMetrics {
    return { ...this.metrics };
  }

  getLastMetrics(): AudioStreamMetrics | null {
    return this.lastMetrics ? { ...this.lastMetrics } : null;
  }

  /** Begin a new logical speech turn, cancelling any prior turn immediately. */
  startTurn(baseTurnId: string, context?: AudioContextLike | null): void {
    if (this.activeBaseTurnId !== null || this.activeSources.size > 0) {
      this.interrupt();
    }
    if (context !== undefined) {
      this.setContext(context);
    }
    this.activeBaseTurnId = baseTurnId;
    this.activeAttemptTurnId = null;
    this.rejectedAttemptIds.clear();
    this.turnStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.expectedSeq = 0;
    this.reorderBuffer.clear();
    this.preBufferBytes = [];
    this.preBufferedByteCount = 0;
    this.pendingOddByte = null;
    this.nextStartTime = 0; this.resetTimeline();
    this.playbackSchedulingStarted = false;
    this.playbackStarted = false;
    this.streamEnded = false;
    this.firstChunkReceived = false;
    this.lastTurnOutcome = "active";
    this.scheduleChain = Promise.resolve();
    this.metrics = this.emptyMetrics(baseTurnId);
  }

  /** Wait until first audible chunk starts, or turn ends/fails/interrupts. */
  waitForPlaybackStart(): Promise<{ started: boolean; interrupted: boolean }> {
    if (this.playbackStarted || this.lastTurnOutcome === "started") {
      return Promise.resolve({ started: true, interrupted: false });
    }
    if (this.activeBaseTurnId === null) {
      return Promise.resolve({ started: false, interrupted: this.lastTurnOutcome === "interrupted" });
    }
    return new Promise((resolve) => {
      this.resolveFirstAudio = resolve;
    });
  }

  /** Wait until the current turn finishes playing all queued chunks or is interrupted. */
  waitForTurnDone(): Promise<AudioStreamMetrics> {
    if (this.activeBaseTurnId === null || (this.streamEnded && this.activeSources.size === 0 && this.preBufferedByteCount === 0)) {
      return Promise.resolve(this.getMetrics());
    }
    return new Promise((resolve) => {
      this.resolveTurnDone = resolve;
    });
  }

  acceptsTurn(turnId: string): boolean {
    if (!this.activeBaseTurnId || !turnId) return false;
    if (this.rejectedAttemptIds.has(turnId)) return false;
    const belongsToTurn =
      turnId === this.activeBaseTurnId || turnId.startsWith(`${this.activeBaseTurnId}:`);
    if (!belongsToTurn) return false;
    if (this.activeAttemptTurnId !== null && turnId !== this.activeAttemptTurnId) {
      return false;
    }
    return true;
  }

  /** Reset a single failed provider attempt before a fallback provider starts. */
  resetAttempt(turnId: string): void {
    if (!this.activeBaseTurnId) return;
    if (turnId !== this.activeBaseTurnId && !turnId.startsWith(`${this.activeBaseTurnId}:`)) return;
    this.rejectedAttemptIds.add(turnId);
    if (this.activeAttemptTurnId === turnId) {
      this.activeAttemptTurnId = null;
      this.expectedSeq = 0;
      this.reorderBuffer.clear();
      this.preBufferBytes = [];
      this.preBufferedByteCount = 0;
      this.pendingOddByte = null;
      this.stopActiveSources();
      this.nextStartTime = 0; this.resetTimeline();
      this.playbackSchedulingStarted = false;
      this.playbackStarted = false;
      this.streamEnded = false;
    }
  }

  /** Enqueue an incoming base64 PCM audio chunk from the stream. */
  enqueueChunk(chunk: {
    turnId: string;
    seq: number;
    audio: string;
    sampleRate?: number;
  }): boolean {
    if (!this.acceptsTurn(chunk.turnId)) {
      return false;
    }
    if (this.activeAttemptTurnId === null) {
      this.activeAttemptTurnId = chunk.turnId;
    }

    const bytes = decodeBase64ToBytes(chunk.audio);
    if (!bytes) {
      return false;
    }

    if (!this.firstChunkReceived) {
      this.firstChunkReceived = true;
      this.metrics.ttfbMs = Math.max(0, Math.round(this.now() - this.turnStartedAt));
    }

    // Deduplicate and enforce strict sequential order.
    if (chunk.seq < this.expectedSeq || this.reorderBuffer.has(chunk.seq)) {
      return false;
    }
    this.reorderBuffer.set(chunk.seq, {
      seq: chunk.seq,
      bytes,
      sampleRate: chunk.sampleRate ?? STREAM_SAMPLE_RATE,
    });

    while (this.reorderBuffer.has(this.expectedSeq)) {
      const next = this.reorderBuffer.get(this.expectedSeq)!;
      this.reorderBuffer.delete(this.expectedSeq);
      this.expectedSeq += 1;
      this.metrics.chunkCount += 1;
      this.acceptOrderedChunk(next);
    }

    return true;
  }

  /** Mark that the server has delivered the final audio chunk for this turn. */
  markTurnComplete(turnId: string): void {
    if (!this.acceptsTurn(turnId)) return;
    this.streamEnded = true;
    this.metrics.totalDurationMs = Math.max(0, Math.round(this.now() - this.turnStartedAt));

    // Flush any small initial pre-buffer (e.g. very short single-word reply).
    if (this.preBufferBytes.length > 0) {
      this.flushPreBuffer(STREAM_SAMPLE_RATE);
    }

    const expectedTurn = this.activeBaseTurnId;
    this.scheduleChain = this.scheduleChain.then(() => {
      if (this.activeBaseTurnId !== expectedTurn) return;
      if (!this.playbackStarted) {
        this.lastTurnOutcome = "completed";
        this.resolveFirstAudio?.({ started: false, interrupted: false });
        this.resolveFirstAudio = null;
      }
      this.checkTurnFinished();
    });
  }

  /** Handle an upstream streaming error for the current turn. */
  markTurnError(turnId: string, message: string): void {
    if (!this.acceptsTurn(turnId)) return;
    const err = new Error(message || "Audio streaming failed");
    const audioStarted = this.playbackStarted;
    this.streamEnded = true;

    if (!audioStarted) {
      this.lastTurnOutcome = "failed";
      this.resolveFirstAudio?.({ started: false, interrupted: false });
      this.resolveFirstAudio = null;
      this.callbacks.onError?.(turnId, err, false);
      this.finishTurnCleanup(false);
    } else {
      // Streaming already started playing: drain queued chunks, never trigger fallback.
      this.callbacks.onError?.(turnId, err, true);
      this.checkTurnFinished();
    }
  }

  /** Immediately stop all active and queued playback for user interruption. */
  interrupt(): AudioStreamMetrics {
    const t0 = this.now();
    const hadTurn = this.activeBaseTurnId !== null || this.activeSources.size > 0;
    const snapshot = this.getMetrics();

    this.activeBaseTurnId = null;
    this.activeAttemptTurnId = null;
    this.rejectedAttemptIds.clear();
    this.expectedSeq = 0;
    this.reorderBuffer.clear();
    this.preBufferBytes = [];
    this.preBufferedByteCount = 0;
    this.pendingOddByte = null;
    this.streamEnded = false;
    this.playbackSchedulingStarted = false;
    this.playbackStarted = false;
    this.lastTurnOutcome = "interrupted";
    this.nextStartTime = 0; this.resetTimeline();

    this.stopActiveSources();

    const latencyMs = Math.max(0, Math.round(this.now() - t0));
    snapshot.interruptLatencyMs = latencyMs;
    this.metrics = snapshot;
    if (hadTurn) {
      this.lastMetrics = { ...snapshot };
      this.logDiagnostic("interrupt", snapshot);
      this.callbacks.onInterrupt?.(snapshot);
    }

    this.resolveFirstAudio?.({ started: false, interrupted: true });
    this.resolveFirstAudio = null;
    this.resolveTurnDone?.(snapshot);
    this.resolveTurnDone = null;

    return snapshot;
  }

  dispose(): void {
    this.interrupt();
    this.teardownGraph();
    this.context = null;
  }

  private acceptOrderedChunk(chunk: DecodedPcmChunk): void {
    const combined = this.mergeOddByte(chunk.bytes);
    if (!combined || combined.byteLength < 2) return;

    if (!this.playbackSchedulingStarted) {
      this.preBufferBytes.push(combined);
      this.preBufferedByteCount += combined.byteLength;
      if (this.preBufferedByteCount >= MIN_INITIAL_BYTES || this.streamEnded) {
        this.flushPreBuffer(chunk.sampleRate);
      }
      return;
    }

    this.enqueueBufferForPlayback(combined, chunk.sampleRate);
  }

  private flushPreBuffer(sampleRate: number): void {
    if (this.preBufferBytes.length === 0) return;
    this.playbackSchedulingStarted = true;
    const merged = new Uint8Array(this.preBufferedByteCount);
    let offset = 0;
    for (const part of this.preBufferBytes) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    this.preBufferBytes = [];
    this.preBufferedByteCount = 0;
    this.enqueueBufferForPlayback(merged, sampleRate);
  }

  private enqueueBufferForPlayback(bytes: Uint8Array, sampleRate: number): void {
    const turnId = this.activeBaseTurnId;
    const attemptTurnId = this.activeAttemptTurnId;
    if (!turnId) return;

    this.scheduleChain = this.scheduleChain
      .then(async () => {
        if (
          this.activeBaseTurnId !== turnId ||
          (attemptTurnId !== null && this.activeAttemptTurnId !== attemptTurnId)
        ) {
          return;
        }
        const ctx = this.context;
        if (!ctx) {
          throw new Error("AudioContext unavailable");
        }
        if (ctx.state !== "running") {
          await ctx.resume();
          if (ctx.state !== "running") {
            throw new Error(`AudioContext state is ${ctx.state}`);
          }
        }
        if (
          this.activeBaseTurnId !== turnId ||
          (attemptTurnId !== null && this.activeAttemptTurnId !== attemptTurnId)
        ) {
          return;
        }

        this.ensureGraph(ctx);
        const samples = pcm16LeToFloat32(bytes);
        if (samples.length === 0) return;

        const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
        audioBuffer.getChannelData(0).set(samples);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode!);

        const now = ctx.currentTime;
        let startAt: number;
        if (!this.playbackStarted || this.nextStartTime === 0) {
          startAt = now + INITIAL_LEAD_SEC;
        } else if (this.nextStartTime < now) {
          const gapMs = Math.round((now - this.nextStartTime) * 1000);
          this.metrics.playbackGaps += 1;
          this.metrics.totalGapMs += Math.max(1, gapMs);
          startAt = now + UNDERRUN_RESUME_LEAD_SEC;
        } else {
          startAt = this.nextStartTime;
        }

        this.nextStartTime = startAt + audioBuffer.duration;
        this.timeline.push({ ctxStart: startAt, contentStart: this.contentCursor, duration: audioBuffer.duration });
        this.contentCursor += audioBuffer.duration;
        this.activeSources.add(source);
        source.onended = () => {
          this.activeSources.delete(source);
          try {
            source.disconnect();
          } catch {
            // Ignore already disconnected source
          }
          if (this.activeBaseTurnId === turnId) {
            this.checkTurnFinished();
          }
        };

        source.start(startAt);

        if (!this.playbackStarted) {
          this.playbackStarted = true;
          this.lastTurnOutcome = "started";
          this.metrics.ttfaMs = Math.max(0, Math.round(this.now() - this.turnStartedAt));
          this.resolveFirstAudio?.({ started: true, interrupted: false });
          this.resolveFirstAudio = null;
          this.callbacks.onPlaybackStart?.(turnId, this.getMetrics());
        }
      })
      .catch((error) => {
        if (this.activeBaseTurnId !== turnId) return;
        const err = error instanceof Error ? error : new Error("Audio playback failed");
        this.markTurnError(attemptTurnId ?? turnId, err.message);
      });
  }

  private resetTimeline(): void {
    this.timeline = [];
    this.contentCursor = 0;
  }

  /**
   * Current playback position in seconds on the turn's audio timeline (the sum
   * of scheduled audio durations), derived from the AudioContext clock. Gaps
   * from buffer underruns do not advance it. Null before playback is scheduled.
   */
  getPlaybackPositionSec(): number | null {
    const ctx = this.context;
    if (!ctx || this.timeline.length === 0) return null;
    const now = ctx.currentTime;
    let position: number | null = null;
    for (const seg of this.timeline) {
      if (seg.ctxStart > now) break;
      position = seg.contentStart + Math.min(seg.duration, now - seg.ctxStart);
    }
    return position;
  }

  private mergeOddByte(bytes: Uint8Array): Uint8Array | null {
    let working = bytes;
    if (this.pendingOddByte !== null) {
      const merged = new Uint8Array(1 + bytes.byteLength);
      merged[0] = this.pendingOddByte;
      merged.set(bytes, 1);
      this.pendingOddByte = null;
      working = merged;
    }
    if (working.byteLength % 2 === 1) {
      this.pendingOddByte = working[working.byteLength - 1];
      working = working.subarray(0, working.byteLength - 1);
    }
    return working.byteLength >= 2 ? working : null;
  }

  private ensureGraph(ctx: AudioContextLike): void {
    if (this.gainNode && this.analyserNode) return;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    this.gainNode = gain;
    this.analyserNode = analyser;
  }

  private teardownGraph(): void {
    try {
      this.gainNode?.disconnect();
    } catch {
      // Ignore
    }
    try {
      this.analyserNode?.disconnect();
    } catch {
      // Ignore
    }
    this.gainNode = null;
    this.analyserNode = null;
  }

  private stopActiveSources(): void {
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop(0);
      } catch {
        // Ignore already stopped source
      }
      try {
        source.disconnect();
      } catch {
        // Ignore
      }
    }
    this.activeSources.clear();
  }

  private checkTurnFinished(): void {
    if (!this.streamEnded || this.activeSources.size > 0 || this.preBufferedByteCount > 0) {
      return;
    }
    this.finishTurnCleanup(true);
  }

  private finishTurnCleanup(emitEndCallback: boolean): void {
    const finalMetrics = this.getMetrics();
    this.lastMetrics = finalMetrics;
    this.activeBaseTurnId = null;
    this.activeAttemptTurnId = null;
    this.playbackSchedulingStarted = false;
    this.playbackStarted = false;
    this.streamEnded = false;
    this.nextStartTime = 0; this.resetTimeline();

    if (emitEndCallback) {
      this.logDiagnostic("complete", finalMetrics);
      this.callbacks.onPlaybackEnd?.(finalMetrics);
    }
    this.resolveTurnDone?.(finalMetrics);
    this.resolveTurnDone = null;
  }

  private emptyMetrics(turnId: string): AudioStreamMetrics {
    return {
      turnId,
      ttfbMs: null,
      ttfaMs: null,
      totalDurationMs: null,
      chunkCount: 0,
      playbackGaps: 0,
      totalGapMs: 0,
      interruptLatencyMs: null,
    };
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private logDiagnostic(phase: "complete" | "interrupt", m: AudioStreamMetrics): void {
    if (typeof console !== "undefined" && typeof console.info === "function") {
      console.info("[audio-stream]", {
        phase,
        ttfbMs: m.ttfbMs,
        ttfaMs: m.ttfaMs,
        totalDurationMs: m.totalDurationMs,
        chunkCount: m.chunkCount,
        playbackGaps: m.playbackGaps,
        totalGapMs: m.totalGapMs,
        interruptLatencyMs: m.interruptLatencyMs,
      });
    }
  }
}
