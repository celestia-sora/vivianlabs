/**
 * Browser client for ElevenLabs Scribe v2 Realtime.
 *
 * - Authenticates with a single-use token minted by `/api/stt/token`.
 * - Streams 16 kHz PCM16, buffering until the socket opens.
 * - Keeps the whole utterance's audio (bounded) so an unexpected disconnect can
 *   be replayed into a fresh session without losing words.
 * - Uses manual commits: `commit()` resolves with the committed transcript.
 */

export const SCRIBE_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SAMPLE_RATE = 16_000;
const MAX_REPLAY_BYTES = SAMPLE_RATE * 2 * 90; // 90 s of PCM16

export interface ScribeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
}

export interface ScribeWord { text: string; start: number; end: number; type?: string }

export interface ScribeCallbacks {
  onPartial(text: string): void;
  onCommitted(text: string): void;
  onWords?(words: ScribeWord[], text: string): void;
  onStatus?(status: "connecting" | "open" | "reconnecting" | "failed" | "closed"): void;
}

export interface ScribeClientOptions {
  fetchToken: () => Promise<string>;
  language?: string;
  callbacks: ScribeCallbacks;
  createSocket?: (url: string) => ScribeSocket;
  maxReconnects?: number;
  backoffMs?: (attempt: number) => number;
}

export function buildScribeUrl(token: string, language?: string): string {
  const params = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    token,
    audio_format: "pcm_16000",
    commit_strategy: "manual",
    include_timestamps: "true",
  });
  if (language && ["th", "en", "ja", "ko", "zh"].includes(language)) params.set("language_code", language);
  return `${SCRIBE_REALTIME_URL}?${params.toString()}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

function pcmBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(i * 2, pcm[i], true);
  return out;
}

const OPEN = 1;

export class ScribeRealtimeClient {
  private readonly o: ScribeClientOptions;
  private socket: ScribeSocket | null = null;
  private opened = false;
  private stopped = false;
  private failed = false;
  private attempts = 0;
  private history: Uint8Array[] = [];
  private historyBytes = 0;
  private unsent: Uint8Array[] = [];
  private lastPartial = "";
  private commitWaiters: Array<(text: string | null) => void> = [];
  private commitRequested = false;
  private heardText = false;
  private connectId = 0;

  constructor(options: ScribeClientOptions) { this.o = options; }

  /** True while the session is usable (or recovering) and has not hard-failed. */
  get healthy(): boolean { return !this.failed && !this.stopped; }
  /** True once any partial/committed text has arrived. */
  get hasText(): boolean { return this.heardText; }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /** Queues a PCM16 chunk (16 kHz mono); sent immediately when the socket is open. */
  sendAudio(pcm: Int16Array): void {
    if (this.stopped || this.failed || pcm.length === 0) return;
    const bytes = pcmBytes(pcm);
    this.history.push(bytes);
    this.historyBytes += bytes.length;
    while (this.historyBytes > MAX_REPLAY_BYTES && this.history.length > 1) this.historyBytes -= this.history.shift()!.length;
    if (this.canSend()) this.send(bytes, false);
    else this.unsent.push(bytes);
  }

  /**
   * Manual commit. Resolves with the committed transcript, `""` when nothing
   * was recognised, or `null` on failure/timeout (caller should fall back).
   */
  commit(timeoutMs = 3500): Promise<string | null> {
    if (this.failed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const idx = this.commitWaiters.indexOf(finish);
        if (idx >= 0) this.commitWaiters.splice(idx, 1);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.commitWaiters.push(finish);
      this.commitRequested = true;
      if (this.canSend()) this.sendCommit();
      // Otherwise the commit is sent right after the buffered audio on open.
    });
  }

  stop(): void {
    this.stopped = true;
    this.connectId += 1;
    this.flushWaiters(null);
    const s = this.socket;
    this.socket = null;
    if (s) { try { s.close(1000, "done"); } catch { /* ignore */ } }
    this.o.callbacks.onStatus?.("closed");
  }

  private canSend(): boolean {
    return !!this.socket && this.opened && this.socket.readyState === OPEN;
  }

  private send(bytes: Uint8Array, commit: boolean): void {
    this.socket?.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: toBase64(bytes),
      sample_rate: SAMPLE_RATE,
      ...(commit ? { commit: true } : {}),
    }));
  }

  /** Commit rides on 100 ms of silence so the payload is never empty. */
  private sendCommit(): void {
    this.commitRequested = false;
    this.send(new Uint8Array(SAMPLE_RATE / 10 * 2), true);
  }

  private async connect(): Promise<void> {
    const id = ++this.connectId;
    this.o.callbacks.onStatus?.(this.attempts === 0 ? "connecting" : "reconnecting");
    let token: string;
    try {
      token = await this.o.fetchToken();
    } catch {
      return this.onDrop(id);
    }
    if (id !== this.connectId || this.stopped) return;
    const create = this.o.createSocket ?? ((url: string) => new WebSocket(url) as unknown as ScribeSocket);
    let socket: ScribeSocket;
    try { socket = create(buildScribeUrl(token, this.o.language)); } catch { return this.onDrop(id); }
    this.socket = socket;
    this.opened = false;
    socket.onopen = () => {
      if (id !== this.connectId) return;
      this.opened = true;
      this.o.callbacks.onStatus?.("open");
      // Replay everything heard so far after a reconnect; otherwise only unsent audio.
      const toSend = this.attempts > 0 ? this.history.slice() : this.unsent.splice(0, this.unsent.length);
      this.unsent = [];
      for (const bytes of toSend) this.send(bytes, false);
      this.attempts = 0;
      if (this.commitRequested) this.sendCommit();
    };
    socket.onmessage = (event) => { if (id === this.connectId) this.handle(event.data); };
    socket.onerror = () => { /* close follows; handled there */ };
    socket.onclose = () => { if (id === this.connectId) this.onDrop(id); };
  }

  private onDrop(id: number): void {
    if (id !== this.connectId || this.stopped) return;
    this.socket = null;
    this.opened = false;
    const max = this.o.maxReconnects ?? 2;
    if (this.attempts >= max) {
      this.failed = true;
      this.o.callbacks.onStatus?.("failed");
      this.flushWaiters(null);
      return;
    }
    this.attempts += 1;
    const delay = this.o.backoffMs ? this.o.backoffMs(this.attempts) : 300 * 3 ** (this.attempts - 1);
    this.o.callbacks.onStatus?.("reconnecting");
    // Re-sent audio covers whatever was in flight, so a pending commit survives.
    if (this.commitWaiters.length) this.commitRequested = true;
    setTimeout(() => { if (!this.stopped && id === this.connectId) void this.connect(); }, delay);
  }

  private flushWaiters(value: string | null): void {
    const waiters = this.commitWaiters.splice(0, this.commitWaiters.length);
    for (const w of waiters) w(value);
  }

  private handle(raw: unknown): void {
    if (typeof raw !== "string") return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const type = msg.message_type;
    const text = typeof msg.text === "string" ? msg.text : "";
    switch (type) {
      case "partial_transcript":
        if (text !== this.lastPartial) {
          this.lastPartial = text;
          if (text) this.heardText = true;
          this.o.callbacks.onPartial(text);
        }
        break;
      case "committed_transcript":
        this.lastPartial = "";
        if (text) this.heardText = true;
        this.o.callbacks.onCommitted(text);
        this.flushWaiters(text);
        break;
      case "committed_transcript_with_timestamps":
        if (Array.isArray(msg.words)) this.o.callbacks.onWords?.(msg.words as ScribeWord[], text);
        break;
      default:
        // Any error/limit event ends the session; the caller falls back to batch STT.
        if (typeof type === "string" && (type === "error" || type.endsWith("_error") || ["quota_exceeded", "unaccepted_terms", "rate_limited", "throttled", "queue_overflow", "resource_exhausted", "session_time_limit_exceeded"].includes(type))) {
          this.failed = true;
          this.o.callbacks.onStatus?.("failed");
          this.flushWaiters(null);
        }
        break;
    }
  }
}
