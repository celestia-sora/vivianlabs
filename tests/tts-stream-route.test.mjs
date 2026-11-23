import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readChatResponse, readProviderStream, timedChatResponse } from "../lib/chat-stream.ts";
import { ElevenLabsDialoguePool } from "../lib/elevenlabs-ws.ts";
import { StreamingTtsSession } from "../lib/tts-stream-session.ts";
import * as speech from "../lib/speech.ts";

const require = createRequire(import.meta.url);

class MockWs {
  readyState = 0;
  sent = [];
  listeners = new Map();
  constructor(url) { this.url = url; }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn); }
  emit(t, ev = {}) { for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev); }
  open() { this.readyState = 1; this.emit("open"); }
  send(data) {
    const parsed = JSON.parse(data);
    this.sent.push(parsed);
    if (Array.isArray(parsed.inputs)) {
      const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]).toString("base64");
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ audio: pcm }) });
        if (parsed.flush) {
          this.emit("message", { data: JSON.stringify({ is_final_audio_for_turn: true }) });
        }
      });
    } else if (parsed.flush) {
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({ is_final_audio_for_turn: true }) });
      });
    }
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

test("LLM SSE deltas stream through StreamingTtsSession and deliver audio chunks before reply completes", async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"[playful] สวัสดีค่ะ! "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"วันนี้เป็นยังไงบ้างคะ"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ];
  const encode = (s) => new TextEncoder().encode(s);
  let releaseSecond;
  const secondGate = new Promise((r) => { releaseSecond = r; });

  const sseResponse = new Response(
    new ReadableStream({
      async start(controller) {
        controller.enqueue(encode(sseChunks[0]));
        await secondGate;
        controller.enqueue(encode(sseChunks[1]));
        controller.enqueue(encode(sseChunks[2]));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

  const pool = new ElevenLabsDialoguePool({ idleTtlMs: 0 });
  const eventsSeen = [];

  const ndjsonResponse = timedChatResponse(async (firstToken, control) => {
    const session = new StreamingTtsSession({
      apiKey: "fixture-key",
      voiceId: "fixture-voice",
      language: "th",
      turnId: "turn-e2e:0",
      emit: control.emit,
      pool,
      createWebSocket: (url) => {
        const ws = new MockWs(url);
        queueMicrotask(() => ws.open());
        return ws;
      },
    });

    const llmRes = await readProviderStream(
      sseResponse,
      "openai",
      () => firstToken("groq"),
      (delta) => session.pushDelta(delta),
    );
    const llmJson = await llmRes.json();
    const replyText = llmJson.choices[0].message.content;
    control.emitReply(200, { text: replyText, scene: { change: false } });
    await session.finish();
    return Response.json({ text: replyText, scene: { change: false } });
  });

  // Unblock second LLM chunk slightly after first audio chunk can arrive
  setTimeout(() => releaseSecond(), 30);

  const result = await readChatResponse(
    ndjsonResponse,
    () => {},
    (event) => eventsSeen.push(event.event),
  );

  assert.equal(result.ok, true);
  assert.match(result.data.text, /สวัสดีค่ะ/);
  assert.ok(eventsSeen.includes("first_token"));
  assert.ok(eventsSeen.includes("audio_chunk"));
  assert.ok(eventsSeen.includes("reply"));
  assert.ok(eventsSeen.includes("audio_turn_end"));

  // Verify first audio_chunk arrived BEFORE final reply event
  const firstAudioIdx = eventsSeen.indexOf("audio_chunk");
  const replyIdx = eventsSeen.indexOf("reply");
  assert.ok(firstAudioIdx >= 0 && firstAudioIdx < replyIdx, `events order was ${eventsSeen.join(",")}`);
});

test("POST /api/tts/stream validates input and streams audio chunks via ElevenLabs V4", async () => {
  const routeSource = ts.transpileModule(
    readFileSync(new URL("../app/api/tts/stream/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  function makeHandler({ denied = null, voiceId = "fixture-voice", user = { id: "user-stream-1", email: "stream@example.com" }, voiceLookups = [] } = {}) {
    const exports = {};
    runInNewContext(routeSource, {
      exports,
      Response,
      ReadableStream,
      TextEncoder,
      crypto: require("node:crypto").webcrypto,
      process: { env: { ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_VOICE_ID: voiceId } },
      require(name) {
        if (name === "@/lib/auth/server") return { requireAuthorizedUser: async () => denied ? { user: null, denied } : { user, denied: null } };
        if (name === "@/lib/rate-limit") return { rateLimit: () => ({ allowed: true }), rateLimitedResponse: () => Response.json({}, { status: 429 }) };
        if (name === "@/lib/speech") return speech;
        if (name === "@/lib/elevenlabs-voice") return {
          normalizeSpeechLanguage: (l) => (l === "th" ? "th" : "global"),
          resolveElevenLabsVoiceId: async (reqVoiceId, userId) => {
            voiceLookups.push({ reqVoiceId, userId });
            return voiceId;
          },
        };
        if (name === "@/lib/tts-stream-session") {
          return {
            StreamingTtsSession: class extends StreamingTtsSession {
              constructor(opts) {
                super({
                  ...opts,
                  pool: new ElevenLabsDialoguePool({ idleTtlMs: 0 }),
                  createWebSocket: (url) => {
                    const ws = new MockWs(url);
                    queueMicrotask(() => ws.open());
                    return ws;
                  },
                });
              }
            },
          };
        }
        if (name === "next/server") return require("next/server");
        throw new Error(`Unexpected import: ${name}`);
      },
    });
    return (body) =>
      exports.POST(
        new Request("https://vivian.example/api/tts/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
  }

  const deniedRes = Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  assert.equal(await makeHandler({ denied: deniedRes })({ text: "สวัสดีค่ะ" }), deniedRes);

  const voiceLookups = [];
  const post = makeHandler({ voiceLookups });
  const emptyRes = await post({ text: "(หลบตา)", language: "th" });
  assert.equal(emptyRes.status, 400);

  const tooLongRes = await post({ text: "ก".repeat(2001), language: "th" });
  assert.equal(tooLongRes.status, 400);

  const okRes = await post({ text: "[playful] ราคา 15 บาทค่ะ!", language: "th", turnId: "stream-turn-1" });
  assert.equal(okRes.status, 200);
  assert.equal(voiceLookups.at(-1)?.userId, "user-stream-1");
  assert.equal(okRes.headers.get("content-type"), "application/x-ndjson");
  const lines = (await okRes.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.some((e) => e.event === "audio_chunk" && e.turnId === "stream-turn-1" && e.format === "pcm_24000"), true);
  assert.equal(lines.some((e) => e.event === "audio_turn_end" && e.turnId === "stream-turn-1"), true);
});
