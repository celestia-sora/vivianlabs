import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildElevenLabsWsUrl,
  ElevenLabsDialoguePool,
  ElevenLabsDialogueTurn,
  validateBase64AudioChunk,
} from "../lib/elevenlabs-ws.ts";
import { AUDIO_STREAM_CONFIG } from "../lib/audio-stream-config.ts";

class MockWebSocket {
  url;
  readyState = 0; // CONNECTING
  sent = [];
  closed = false;
  closeCalls = [];
  listeners = new Map();

  constructor(url) {
    this.url = url;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn(event);
    }
  }

  open() {
    this.readyState = 1; // OPEN
    this.emit("open");
  }

  serverMessage(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = "") {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.closeCalls.push({ code, reason });
    this.emit("close", { code, reason });
  }
}

test("ElevenLabs WebSocket URL uses Text-to-Dialogue endpoint and eleven_v4 model", () => {
  assert.equal(AUDIO_STREAM_CONFIG.modelId, "eleven_v4");
  const url = buildElevenLabsWsUrl({ language: "th" });
  assert.ok(url.startsWith("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?"));
  assert.equal(url.includes("/text-to-speech/"), false);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("model_id"), "eleven_v4");
  assert.equal(parsed.searchParams.get("output_format"), "pcm_24000");
  assert.equal(parsed.searchParams.get("language_code"), "th");
  assert.equal(parsed.searchParams.get("apply_text_normalization"), "auto");
});

test("validateBase64AudioChunk rejects empty and invalid base64 payloads", () => {
  assert.deepEqual(validateBase64AudioChunk(""), { ok: false, reason: "empty" });
  assert.deepEqual(validateBase64AudioChunk("   "), { ok: false, reason: "empty" });
  assert.deepEqual(validateBase64AudioChunk("not!valid@base64"), { ok: false, reason: "invalid_base64" });
  const valid = Buffer.from([1, 2, 3, 4]).toString("base64");
  assert.deepEqual(validateBase64AudioChunk(valid), { ok: true, base64: valid, byteLength: 4 });
});

test("streams phrases incrementally, forwards audio immediately before finish(), and reuses pooled socket", async () => {
  const sockets = [];
  const pool = new ElevenLabsDialoguePool({ idleTtlMs: 5000 });
  const chunks = [];
  let turnEnded = null;

  const turn1 = new ElevenLabsDialogueTurn(
    {
      apiKey: "secret-eleven-key",
      voiceId: "voice-vivian",
      language: "th",
      turnId: "turn-1",
      turnTimeoutMs: 500,
      pool,
      createWebSocket: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => ws.open());
        return ws;
      },
    },
    {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onTurnEnd: (metrics) => { turnEnded = metrics; },
    },
  );

  turn1.sendPhrase("[playful] สวัสดีค่ะ!", true);
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  assert.deepEqual(ws.sent[0], { voices: ["voice-vivian"], xi_api_key: "secret-eleven-key" });
  assert.deepEqual(ws.sent[1], {
    inputs: [{ text: "[playful] สวัสดีค่ะ!", voice_id: "voice-vivian", new_turn: true }],
    flush: true,
  });

  const pcmA = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).toString("base64");
  const pcmB = Buffer.from([5, 0, 6, 0, 7, 0, 8, 0]).toString("base64");

  // Audio chunk + flush turn boundary for phrase 1 arrive BEFORE second phrase or finish()
  ws.serverMessage({ audio: pcmA });
  ws.serverMessage({ is_final_audio_for_turn: true });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].seq, 0);
  assert.equal(chunks[0].audio, pcmA);
  assert.equal(turnEnded, null, "first phrase flush must not end the turn before finish()");

  turn1.sendPhrase("วันนี้เป็นยังไงบ้างคะ", false);
  assert.deepEqual(ws.sent[2], {
    inputs: [{ text: "วันนี้เป็นยังไงบ้างคะ", voice_id: "voice-vivian", new_turn: false }],
  });

  const finishing = turn1.finish();
  assert.deepEqual(ws.sent[3], { flush: true });

  ws.serverMessage({ audio: pcmB });
  ws.serverMessage({ is_final_audio_for_turn: true });
  await finishing;

  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].seq, 1);
  assert.equal(turnEnded.chunkCount, 2);
  assert.equal(ws.closed, false, "healthy socket is returned to pool for reuse");

  // Second turn reuses the same open WebSocket without re-authenticating
  const chunks2 = [];
  const turn2 = new ElevenLabsDialogueTurn(
    {
      apiKey: "secret-eleven-key",
      voiceId: "voice-vivian",
      language: "th",
      turnId: "turn-2",
      pool,
      createWebSocket: () => {
        assert.fail("Expected pooled WebSocket reuse instead of opening a second connection");
      },
    },
    {
      onAudioChunk: (chunk) => chunks2.push(chunk),
    },
  );
  turn2.sendPhrase("กลับมาแล้วค่ะ", true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ws.sent[4], {
    inputs: [{ text: "กลับมาแล้วค่ะ", voice_id: "voice-vivian", new_turn: true }],
    flush: true,
  });
  ws.serverMessage({ audio: pcmA });
  ws.serverMessage({ is_final_audio_for_turn: true });
  await turn2.finish();
  assert.equal(chunks2.length, 1);

  pool.drainAll();
  assert.deepEqual(ws.sent.at(-1), { close_socket: true });
  assert.equal(ws.closed, true);
});

test("reconnects once on disconnect before first audio and aborts cleanly on interruption", async () => {
  const sockets = [];
  const pool = new ElevenLabsDialoguePool({ idleTtlMs: 0 });
  const chunks = [];

  const turn = new ElevenLabsDialogueTurn(
    {
      apiKey: "secret-eleven-key",
      voiceId: "voice-vivian",
      language: "th",
      turnId: "turn-reconnect",
      pool,
      createWebSocket: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => ws.open());
        return ws;
      },
    },
    { onAudioChunk: (c) => chunks.push(c) },
  );

  turn.sendPhrase("ทดสอบเชื่อมต่อใหม่ค่ะ", true);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(sockets.length, 1);

  // Drop first socket before any audio arrives -> triggers single reconnect
  sockets[0].close(1006, "dropped");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 2);

  const pcm = Buffer.from([10, 0, 20, 0]).toString("base64");
  sockets[1].serverMessage({ audio: pcm });
  sockets[1].serverMessage({ is_final_audio_for_turn: true });
  await turn.finish();
  assert.equal(chunks.length, 1);

  // Now test interruption via AbortController
  const controller = new AbortController();
  const errors = [];
  const abortedTurn = new ElevenLabsDialogueTurn(
    {
      apiKey: "secret-eleven-key",
      voiceId: "voice-vivian",
      language: "th",
      turnId: "turn-abort",
      signal: controller.signal,
      pool,
      createWebSocket: (url) => {
        const ws = new MockWebSocket(url);
        sockets.push(ws);
        queueMicrotask(() => ws.open());
        return ws;
      },
    },
    {
      onAudioChunk: () => {},
      onError: (err) => errors.push(err),
    },
  );

  abortedTurn.sendPhrase("กำลังพูดอยู่แล้วโดนขัดจังหวะ", true);
  await new Promise((r) => setTimeout(r, 15));
  const finishPromise = abortedTurn.finish();
  controller.abort();
  await assert.rejects(finishPromise, { name: "AbortError" });
  assert.equal(sockets[2].closed, true);
  assert.equal(errors.length, 0);
});

test("invalid base64 audio triggers controlled error without leaking API key in diagnostics", async () => {
  const pool = new ElevenLabsDialoguePool({ idleTtlMs: 0 });
  const errors = [];
  const logs = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logs.push(JSON.stringify(args));

  try {
    const wsRef = { current: null };
    const turn = new ElevenLabsDialogueTurn(
      {
        apiKey: "super-secret-elevenlabs-key-12345",
        voiceId: "voice-vivian",
        language: "th",
        turnId: "turn-bad-b64",
        pool,
        createWebSocket: (url) => {
          const ws = new MockWebSocket(url);
          wsRef.current = ws;
          queueMicrotask(() => ws.open());
          return ws;
        },
      },
      {
        onAudioChunk: () => assert.fail("invalid chunk must not be emitted"),
        onError: (err) => errors.push(err),
      },
    );

    turn.sendPhrase("สวัสดีค่ะ", true);
    await new Promise((r) => setTimeout(r, 15));
    wsRef.current.serverMessage({ audio: "!!!not-valid-base64!!!" });
    await assert.rejects(turn.finish());
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "TTS_INVALID_AUDIO");
    assert.equal(logs.some((line) => line.includes("super-secret-elevenlabs-key-12345")), false);
  } finally {
    console.warn = originalWarn;
  }
});


test("forwards standalone non-verbal audio tags unchanged to ElevenLabs v4", async () => {
  const pool = new ElevenLabsDialoguePool({ idleTtlMs: 0 });
  let socket;
  const chunks = [];
  const turn = new ElevenLabsDialogueTurn(
    {
      apiKey: "fixture-key",
      voiceId: "fixture-voice",
      language: "th",
      turnId: "turn-audio-tag",
      pool,
      createWebSocket: (url) => {
        socket = new MockWebSocket(url);
        queueMicrotask(() => socket.open());
        return socket;
      },
    },
    { onAudioChunk: (chunk) => chunks.push(chunk) },
  );

  turn.sendPhrase("[laughs]", true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(socket.sent[1], {
    inputs: [{ text: "[laughs]", voice_id: "fixture-voice", new_turn: true }],
    flush: true,
  });

  socket.serverMessage({ audio: Buffer.from([1, 0, 2, 0]).toString("base64") });
  socket.serverMessage({ is_final_audio_for_turn: true });
  await turn.finish();
  assert.equal(chunks.length, 1);
  pool.drainAll();
});
