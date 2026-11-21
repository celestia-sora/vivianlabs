import {
  AUDIO_STREAM_CONFIG,
  STREAM_OUTPUT_FORMAT,
  STREAM_SAMPLE_RATE,
} from "./audio-stream-config.ts";
import { elevenLabsLanguageParam, normalizeSpeechLanguage } from "./elevenlabs-voice.ts";

export const ELEVENLABS_TTD_WS_URL =
  "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateBase64AudioChunk(raw: unknown): { ok: true; base64: string; byteLength: number } | { ok: false; reason: "empty" | "invalid_base64" } {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const trimmed = raw.replace(/\s+/g, "");
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length % 4 !== 0 || !BASE64_PATTERN.test(trimmed)) {
    return { ok: false, reason: "invalid_base64" };
  }
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, base64: trimmed, byteLength: bytes.byteLength };
}

export function buildElevenLabsWsUrl(options: {
  modelId?: string;
  outputFormat?: string;
  language?: string;
}): string {
  const params = new URLSearchParams();
  params.set("model_id", options.modelId ?? AUDIO_STREAM_CONFIG.modelId);
  params.set("output_format", options.outputFormat ?? STREAM_OUTPUT_FORMAT);
  params.set("apply_text_normalization", "auto");
  const langParam = elevenLabsLanguageParam(normalizeSpeechLanguage(options.language));
  if (langParam) {
    params.set("language_code", langParam);
  }
  return `${ELEVENLABS_TTD_WS_URL}?${params.toString()}`;
}

export interface ElevenLabsTurnCallbacks {
  onAudioChunk: (chunk: {
    turnId: string;
    seq: number;
    audio: string;
    byteLength: number;
    format: typeof STREAM_OUTPUT_FORMAT;
    sampleRate: number;
  }) => void;
  onTurnEnd?: (metrics: {
    turnId: string;
    chunkCount: number;
    ttfbMs: number | null;
    totalDurationMs: number;
  }) => void;
  onError?: (error: {
    turnId: string;
    code: string;
    message: string;
    audioStarted: boolean;
  }) => void;
}

export interface ElevenLabsTurnOptions {
  apiKey: string;
  voiceId: string;
  language?: string;
  turnId: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  turnTimeoutMs?: number;
  createWebSocket?: WebSocketFactory;
  pool?: ElevenLabsDialoguePool;
}

interface PooledConnection {
  key: string;
  ws: WebSocketLike;
  voiceId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inUse: boolean;
  closed: boolean;
}

const DEFAULT_IDLE_TTL_MS = 12_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 22_000;
const KEEP_ALIVE_INTERVAL_MS = 12_000;

export class ElevenLabsDialoguePool {
  private readonly idle = new Map<string, PooledConnection[]>();
  private readonly maxIdlePerKey: number;
  private readonly idleTtlMs: number;

  constructor(options: { maxIdlePerKey?: number; idleTtlMs?: number } = {}) {
    this.maxIdlePerKey = options.maxIdlePerKey ?? 2;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  private poolKey(voiceId: string, language: string, outputFormat: string): string {
    return `${voiceId}:${normalizeSpeechLanguage(language)}:${outputFormat}`;
  }

  async acquire(params: {
    apiKey: string;
    voiceId: string;
    language: string;
    outputFormat: string;
    connectTimeoutMs: number;
    signal?: AbortSignal;
    createWebSocket: WebSocketFactory;
  }): Promise<{ conn: PooledConnection; reused: boolean }> {
    const key = this.poolKey(params.voiceId, params.language, params.outputFormat);
    const list = this.idle.get(key);
    while (list && list.length > 0) {
      const candidate = list.pop()!;
      if (candidate.idleTimer) {
        clearTimeout(candidate.idleTimer);
        candidate.idleTimer = null;
      }
      if (!candidate.closed && candidate.ws.readyState === WS_OPEN) {
        candidate.inUse = true;
        if (list.length === 0) this.idle.delete(key);
        return { conn: candidate, reused: true };
      }
      this.destroy(candidate, false);
    }
    if (list && list.length === 0) this.idle.delete(key);

    const url = buildElevenLabsWsUrl({
      modelId: AUDIO_STREAM_CONFIG.modelId,
      outputFormat: params.outputFormat,
      language: params.language,
    });
    const ws = params.createWebSocket(url);
    const conn: PooledConnection = {
      key,
      ws,
      voiceId: params.voiceId,
      idleTimer: null,
      inUse: true,
      closed: false,
    };

    await this.waitForOpen(ws, params.connectTimeoutMs, params.signal);
    // Register voice and authenticate server-side in the first frame.
    // Never log apiKey.
    ws.send(
      JSON.stringify({
        voices: [params.voiceId],
        xi_api_key: params.apiKey,
      }),
    );

    return { conn, reused: false };
  }

  release(conn: PooledConnection, reusable: boolean): void {
    conn.inUse = false;
    if (!reusable || conn.closed || conn.ws.readyState !== WS_OPEN || this.idleTtlMs <= 0) {
      this.destroy(conn, reusable);
      return;
    }

    const list = this.idle.get(conn.key) ?? [];
    if (list.length >= this.maxIdlePerKey) {
      this.destroy(conn, true);
      return;
    }

    const onUnexpectedClose = () => {
      conn.closed = true;
      if (conn.idleTimer) {
        clearTimeout(conn.idleTimer);
        conn.idleTimer = null;
      }
      const bucket = this.idle.get(conn.key);
      if (bucket) {
        const idx = bucket.indexOf(conn);
        if (idx >= 0) bucket.splice(idx, 1);
        if (bucket.length === 0) this.idle.delete(conn.key);
      }
      conn.ws.removeEventListener("close", onUnexpectedClose);
    };
    conn.ws.addEventListener("close", onUnexpectedClose);

    conn.idleTimer = setTimeout(() => {
      conn.ws.removeEventListener("close", onUnexpectedClose);
      const bucket = this.idle.get(conn.key);
      if (bucket) {
        const idx = bucket.indexOf(conn);
        if (idx >= 0) bucket.splice(idx, 1);
        if (bucket.length === 0) this.idle.delete(conn.key);
      }
      this.destroy(conn, true);
    }, this.idleTtlMs);
    if (typeof (conn.idleTimer as { unref?: () => void }).unref === "function") {
      (conn.idleTimer as { unref: () => void }).unref();
    }

    list.push(conn);
    this.idle.set(conn.key, list);
  }

  destroy(conn: PooledConnection, sendCloseSocket: boolean): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.inUse = false;
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = null;
    }
    try {
      if (sendCloseSocket && conn.ws.readyState === WS_OPEN) {
        conn.ws.send(JSON.stringify({ close_socket: true }));
      }
    } catch {
      // Ignore send errors on closing socket
    }
    try {
      if (conn.ws.readyState === WS_OPEN || conn.ws.readyState === WS_CONNECTING) {
        conn.ws.close(1000, "session closed");
      }
    } catch {
      // Ignore close errors
    }
  }

  drainAll(): void {
    for (const list of this.idle.values()) {
      for (const conn of list) {
        this.destroy(conn, true);
      }
    }
    this.idle.clear();
  }

  private waitForOpen(
    ws: WebSocketLike,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      try { ws.close(); } catch { /* ignore */ }
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    if (ws.readyState === WS_OPEN) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("ElevenLabs WebSocket connection error"));
      };
      const onClose = (event: { code?: number; reason?: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`ElevenLabs WebSocket closed before open (${event.code ?? 1006})`));
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch { /* ignore */ }
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("ElevenLabs WebSocket connection timed out"));
      }, timeoutMs);

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export const defaultElevenLabsPool = new ElevenLabsDialoguePool();

interface QueuedInput {
  text: string;
  flush: boolean;
}

/**
 * Manages one active speech turn over an ElevenLabs Text-to-Dialogue v4
 * WebSocket connection. Buffers outgoing phrases until the socket opens,
 * forwards incoming base64 audio chunks immediately, supports single-retry
 * reconnect before first audio, and aborts cleanly on interruption.
 */
export class ElevenLabsDialogueTurn {
  private readonly options: ElevenLabsTurnOptions;
  private readonly callbacks: ElevenLabsTurnCallbacks;
  private readonly pool: ElevenLabsDialoguePool;
  private readonly createWebSocket: WebSocketFactory;
  private readonly startedAt = Date.now();

  private conn: PooledConnection | null = null;
  private connectPromise: Promise<void> | null = null;
  private sentPhrases: QueuedInput[] = [];
  private pendingPhrases: QueuedInput[] = [];
  private finishing = false;
  private finished = false;
  private aborted = false;
  private firstTextSent = false;
  private hasUnflushedInputs = false;
  private unacknowledgedFlushes = 0;
  private seq = 0;\n  private audioTagCount = 0;
  private firstAudioAt: number | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private retriedBeforeAudio = false;
  private errorReported = false;

  private resolveTurn!: () => void;
  private rejectTurn!: (err: Error) => void;
  private readonly turnPromise: Promise<void>;

  private onMessageListener: ((event: { data: unknown }) => void) | null = null;
  private onErrorListener: ((event: unknown) => void) | null = null;
  private onCloseListener: ((event: { code?: number; reason?: string }) => void) | null = null;
  private onAbortListener: (() => void) | null = null;

  constructor(options: ElevenLabsTurnOptions, callbacks: ElevenLabsTurnCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
    this.pool = options.pool ?? defaultElevenLabsPool;
    this.createWebSocket =
      options.createWebSocket ?? ((url) => new globalThis.WebSocket(url) as unknown as WebSocketLike);
    this.turnPromise = new Promise<void>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
    });
    // Prevent unhandled rejection if caller aborts before awaiting finish().
    this.turnPromise.catch(() => {});

    if (options.signal) {
      if (options.signal.aborted) {
        this.abort();
      } else {
        this.onAbortListener = () => this.abort();
        options.signal.addEventListener("abort", this.onAbortListener, { once: true });
      }
    }
  }

  /** Pre-warm the WebSocket connection concurrently with LLM generation. */
  warmup(): void {
    if (this.aborted || this.finished) return;
    void this.ensureConnected().catch(() => {
      // Errors during warmup are handled when phrases are sent / finish() is awaited.
    });
  }

  /** Send a segmented phrase to ElevenLabs. Safe to call while connecting. */
  sendPhrase(taggedText: string, flush = false): void {
    if (this.aborted || this.finished || !taggedText.trim()) return;
    const item: QueuedInput = { text: taggedText, flush };
    this.sentPhrases.push(item);

    if (this.conn && !this.conn.closed && this.conn.ws.readyState === WS_OPEN) {
      this.dispatchPhrase(this.conn.ws, item);
      return;
    }

    this.pendingPhrases.push(item);
    void this.ensureConnected().catch((err) => {
      this.handleFailure("TTS_WS_CONNECT_FAILED", err instanceof Error ? err.message : "WebSocket connect failed");
    });
  }

  /**
   * Signal that no more text will arrive for this turn, flush any buffered
   * audio at ElevenLabs, and resolve when `is_final_audio_for_turn` arrives.
   */
  async finish(): Promise<void> {
    if (this.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (this.finished) {
      return this.turnPromise;
    }
    this.finishing = true;

    // Nothing spoken for this turn (e.g. empty or stage-direction-only text).
    if (this.sentPhrases.length === 0) {
      this.completeCleanly();
      return this.turnPromise;
    }

    this.armTurnTimeout();
    if (this.conn && !this.conn.closed && this.conn.ws.readyState === WS_OPEN) {
      if (this.hasUnflushedInputs) {
        this.hasUnflushedInputs = false;
        this.unacknowledgedFlushes += 1;
        this.conn.ws.send(JSON.stringify({ flush: true }));
      } else if (this.unacknowledgedFlushes === 0) {
        this.completeCleanly();
      }
      return this.turnPromise;
    }
    try {
      await this.ensureConnected();
      if (this.aborted || this.finished) return this.turnPromise;
      if (this.hasUnflushedInputs && this.conn && this.conn.ws.readyState === WS_OPEN) {
        this.hasUnflushedInputs = false;
        this.unacknowledgedFlushes += 1;
        this.conn.ws.send(JSON.stringify({ flush: true }));
      } else if (!this.hasUnflushedInputs && this.unacknowledgedFlushes === 0) {
        this.completeCleanly();
      }
    } catch (err) {
      this.handleFailure("TTS_WS_FAILED", err instanceof Error ? err.message : "WebSocket failed");
    }

    return this.turnPromise;
  }

  /** Immediately stop synthesis, close the socket, and reject pending waits. */
  abort(): void {
    if (this.aborted || this.finished) return;
    this.aborted = true;
    this.cleanupTimersAndListeners();
    if (this.conn) {
      this.pool.destroy(this.conn, false);
      this.conn = null;
    }
    const abortErr = new DOMException("Aborted", "AbortError");
    this.rejectTurn(abortErr);
  }

  private async ensureConnected(): Promise<void> {
    if (this.aborted || this.finished) return;
    if (this.conn && !this.conn.closed && this.conn.ws.readyState === WS_OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const { conn } = await this.pool.acquire({
          apiKey: this.options.apiKey,
          voiceId: this.options.voiceId,
          language: this.options.language ?? "global",
          outputFormat: STREAM_OUTPUT_FORMAT,
          connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          signal: this.options.signal,
          createWebSocket: this.createWebSocket,
        });

        if (this.aborted || this.finished) {
          this.pool.release(conn, true);
          return;
        }

        this.conn = conn;
        this.attachSocketListeners(conn);
        this.startKeepAlive();

        const toSend = this.pendingPhrases.splice(0, this.pendingPhrases.length);
        for (const item of toSend) {
          this.dispatchPhrase(conn.ws, item);
        }

        if (this.finishing && this.hasUnflushedInputs && conn.ws.readyState === WS_OPEN) {
          this.hasUnflushedInputs = false;
          this.unacknowledgedFlushes += 1;
          conn.ws.send(JSON.stringify({ flush: true }));
        }
      } finally {
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  private dispatchPhrase(ws: WebSocketLike, item: QueuedInput): void {
    this.audioTagCount += [...item.text.matchAll(/\[[^\]\n]{1,120}\]/gu)].length;
    const newTurn = !this.firstTextSent;
    this.firstTextSent = true;
    if (item.flush) {
      this.hasUnflushedInputs = false;
      this.unacknowledgedFlushes += 1;
    } else {
      this.hasUnflushedInputs = true;
    }
    ws.send(
      JSON.stringify({
        inputs: [
          {
            text: item.text,
            voice_id: this.options.voiceId,
            new_turn: newTurn,
          },
        ],
        ...(item.flush ? { flush: true } : {}),
      }),
    );
  }

  private attachSocketListeners(conn: PooledConnection): void {
    this.detachSocketListeners(conn);
    const ws = conn.ws;

    this.onMessageListener = (event) => {
      if (this.aborted || this.finished || this.conn !== conn) return;
      this.handleMessage(event.data);
    };
    this.onErrorListener = () => {
      if (this.aborted || this.finished || this.conn !== conn) return;
      void this.handleDisconnectOrError("TTS_WS_ERROR", "ElevenLabs WebSocket error");
    };
    this.onCloseListener = (event) => {
      if (this.aborted || this.finished || this.conn !== conn) return;
      void this.handleDisconnectOrError(
        "TTS_WS_CLOSED",
        `ElevenLabs WebSocket closed (${event.code ?? 1006})`,
      );
    };

    ws.addEventListener("message", this.onMessageListener);
    ws.addEventListener("error", this.onErrorListener);
    ws.addEventListener("close", this.onCloseListener);
  }

  private detachSocketListeners(conn: PooledConnection): void {
    if (this.onMessageListener) conn.ws.removeEventListener("message", this.onMessageListener);
    if (this.onErrorListener) conn.ws.removeEventListener("error", this.onErrorListener);
    if (this.onCloseListener) conn.ws.removeEventListener("close", this.onCloseListener);
    this.onMessageListener = null;
    this.onErrorListener = null;
    this.onCloseListener = null;
  }

  private handleMessage(rawData: unknown): void {
    const text = typeof rawData === "string" ? rawData : String(rawData ?? "");
    if (!text) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.warn("ElevenLabs WS returned malformed JSON frame");
      return;
    }

    if (msg.error) {
      const code = typeof msg.code === "string" || typeof msg.code === "number" ? String(msg.code) : "TTS_WS_UPSTREAM_ERROR";
      const errMsg = typeof msg.error === "string" ? msg.error : "ElevenLabs WebSocket error";
      this.handleFailure(code, errMsg);
      return;
    }

    if (typeof msg.audio === "string") {
      const validated = validateBase64AudioChunk(msg.audio);
      if (!validated.ok) {
        if (validated.reason === "invalid_base64") {
          console.warn("ElevenLabs WS returned invalid base64 audio chunk");
          this.handleFailure("TTS_INVALID_AUDIO", "Invalid audio chunk received");
        }
        return;
      }

      if (this.firstAudioAt === null) {
        this.firstAudioAt = Date.now();
      }
      // Reset turn watchdog whenever active audio is flowing.
      if (this.finishing) this.armTurnTimeout();

      this.callbacks.onAudioChunk({
        turnId: this.options.turnId,
        seq: this.seq++,
        audio: validated.base64,
        byteLength: validated.byteLength,
        format: STREAM_OUTPUT_FORMAT,
        sampleRate: STREAM_SAMPLE_RATE,
      });
    }

    if (msg.is_final_audio_for_turn === true) {
      if (this.unacknowledgedFlushes > 0) this.unacknowledgedFlushes -= 1;
      if (this.finishing && !this.hasUnflushedInputs && this.unacknowledgedFlushes === 0) {
        this.completeCleanly();
      }
      return;
    }

    if (msg.is_final === true) {
      this.completeCleanly();
    }
  }

  private async handleDisconnectOrError(code: string, message: string): Promise<void> {
    if (this.aborted || this.finished) return;
    if (this.conn) {
      this.detachSocketListeners(this.conn);
      this.pool.destroy(this.conn, false);
      this.conn = null;
    }

    // Safe single reconnect only before any audio has been sent to the client.
    if (
      AUDIO_STREAM_CONFIG.reconnect &&
      !this.retriedBeforeAudio &&
      this.seq === 0 &&
      this.sentPhrases.length > 0 &&
      !this.options.signal?.aborted
    ) {
      this.retriedBeforeAudio = true;
      this.firstTextSent = false;
      this.hasUnflushedInputs = false;
      this.unacknowledgedFlushes = 0;
      this.pendingPhrases = [...this.sentPhrases];
      try {
        await this.ensureConnected();
        return;
      } catch (err) {
        this.handleFailure(
          code,
          err instanceof Error ? err.message : message,
        );
        return;
      }
    }

    // If audio was already delivered and the server closed after flush/final, treat gracefully only if turn ended; otherwise report error.
    this.handleFailure(code, message);
  }

  private completeCleanly(): void {
    if (this.finished || this.aborted) return;
    this.finished = true;
    this.cleanupTimersAndListeners();
    if (this.conn) {
      this.detachSocketListeners(this.conn);
      this.pool.release(this.conn, true);
      this.conn = null;
    }

    const totalDurationMs = Date.now() - this.startedAt;
    const ttfbMs = this.firstAudioAt !== null ? this.firstAudioAt - this.startedAt : null;

    console.info("ElevenLabs WS turn complete", {
      modelId: AUDIO_STREAM_CONFIG.modelId,
      chunkCount: this.seq,
      audioTagCount: this.audioTagCount,
      ttfbMs,
      totalDurationMs,
    });

    this.callbacks.onTurnEnd?.({
      turnId: this.options.turnId,
      chunkCount: this.seq,
      ttfbMs,
      totalDurationMs,
    });
    this.resolveTurn();
  }

  private handleFailure(code: string, message: string): void {
    if (this.finished || this.aborted) return;
    this.finished = true;
    this.cleanupTimersAndListeners();
    if (this.conn) {
      this.detachSocketListeners(this.conn);
      this.pool.destroy(this.conn, false);
      this.conn = null;
    }

    const audioStarted = this.seq > 0;
    console.warn("ElevenLabs WS turn failed", {
      modelId: AUDIO_STREAM_CONFIG.modelId,
      code,
      audioStarted,
      chunkCount: this.seq,
      elapsedMs: Date.now() - this.startedAt,
    });

    if (!this.errorReported) {
      this.errorReported = true;
      this.callbacks.onError?.({
        turnId: this.options.turnId,
        code,
        message,
        audioStarted,
      });
    }
    this.rejectTurn(new Error(message));
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.aborted || this.finished || !this.conn || this.conn.ws.readyState !== WS_OPEN) return;
      try {
        this.conn.ws.send(JSON.stringify({ keep_alive: true }));
      } catch {
        // Ignore keep-alive send errors; close/error handler will run.
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    if (typeof (this.keepAliveTimer as { unref?: () => void }).unref === "function") {
      (this.keepAliveTimer as { unref: () => void }).unref();
    }
  }

  private armTurnTimeout(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      this.handleFailure("TTS_TIMEOUT", "ElevenLabs WebSocket audio timed out");
    }, this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    if (typeof (this.turnTimer as { unref?: () => void }).unref === "function") {
      (this.turnTimer as { unref: () => void }).unref();
    }
  }

  private cleanupTimersAndListeners(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.onAbortListener && this.options.signal) {
      this.options.signal.removeEventListener("abort", this.onAbortListener);
      this.onAbortListener = null;
    }
  }
}
