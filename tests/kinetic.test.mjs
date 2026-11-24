import test from "node:test";
import assert from "node:assert/strict";
import { segmentText, wordsFromTimedChars } from "../lib/kinetic/segment.ts";
import { AlignmentAccumulator, parseAlignment } from "../lib/kinetic/alignment.ts";
import { TtsSyncController } from "../lib/kinetic/tts-sync.ts";
import { SttSyncController } from "../lib/kinetic/stt-sync.ts";

function raw(text, startAt, step = 0.1) {
  const chars = [...text];
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => startAt + i * step),
    character_end_times_seconds: chars.map((_, i) => startAt + (i + 1) * step),
  };
}

test("segments English with attached punctuation", () => {
  assert.deepEqual(segmentText("Hello, world! How are you?", "en"), ["Hello,", "world!", "How", "are", "you?"]);
});

test("segments Thai without spaces and mixed Thai-English, ignoring audio tags", () => {
  const words = segmentText("[shy] สวัสดีค่ะ hello วันนี้", "th");
  assert.ok(words.length >= 4, words.join("|"));
  assert.ok(words.includes("hello"));
  assert.equal(words.join(""), "สวัสดีค่ะhelloวันนี้");
  assert.ok(!words.some((w) => w.includes("[") || w.includes("shy")));
});

test("parseAlignment rejects malformed data", () => {
  assert.equal(parseAlignment(null), null);
  assert.equal(parseAlignment({ characters: ["a"], character_start_times_seconds: [0] }), null);
  assert.ok(parseAlignment(raw("ab", 0)));
});

test("accumulator handles chunk-relative times by adding emitted audio duration", () => {
  const acc = new AlignmentAccumulator(10);
  const a = acc.push(raw("ab ", 0), 0.3);
  const b = acc.push(raw("cd", 0), 0.2); // restarts at 0 -> chunk-relative
  assert.equal(a[0].start, 10);
  assert.ok(Math.abs(b[0].start - 10.3) < 1e-9, String(b[0].start));
  assert.ok(b[0].start >= a[a.length - 1].start);
});

test("accumulator keeps cumulative times unchanged", () => {
  const acc = new AlignmentAccumulator(0);
  acc.push(raw("ab ", 0), 0.3);
  const b = acc.push(raw("cd", 0.3), 0.2);
  assert.ok(Math.abs(b[0].start - 0.3) < 1e-9);
});

test("wordsFromTimedChars maps timing onto words", () => {
  const chars = [];
  const acc = new AlignmentAccumulator(0);
  chars.push(...acc.push(raw("[laughs] Hi there.", 0), 2));
  const words = wordsFromTimedChars(chars, "en");
  assert.deepEqual(words.map((w) => w.text), ["Hi", "there."]);
  assert.ok(words[1].startSec > words[0].startSec && words[1].endSec > words[1].startSec);
});

test("TtsSyncController follows playback position and interrupts", () => {
  const c = new TtsSyncController();
  c.startTurn("t1");
  c.addWords("stale", [{ id: "x", text: "x", startSec: 0, endSec: 1 }]);
  c.addWords("t1", [
    { id: "w0", text: "a", startSec: 0.1, endSec: 0.4 },
    { id: "w1", text: "b", startSec: 0.5, endSec: 0.9 },
  ]);
  assert.deepEqual(c.frame(0.05), []);
  assert.deepEqual(c.frame(0.2).map((w) => [w.text, w.state]), [["a", "active"]]);
  assert.deepEqual(c.frame(0.6).map((w) => [w.text, w.state]), [["a", "past"], ["b", "active"]]);
  assert.equal(c.frame(null).length, 0);
  c.end("t1");
  assert.equal(c.isFinished(0.8), false);
  assert.equal(c.isFinished(1), true);
  c.interrupt();
  assert.equal(c.frame(5).length, 0);
});

test("TtsSyncController windows long text", () => {
  const c = new TtsSyncController();
  c.startTurn("t");
  c.addWords("t", Array.from({ length: 20 }, (_, i) => ({ id: `w${i}`, text: `${i}`, startSec: i, endSec: i + 0.5 })));
  const f = c.frame(19.1);
  assert.equal(f.length, 10);
  assert.equal(f[9].text, "19");
});

test("SttSyncController replaces partials without duplicating and commits once", () => {
  const s = new SttSyncController("en");
  s.partial("hello wor");
  s.partial("hello world");
  assert.deepEqual(s.frame().map((w) => w.text), ["hello", "world"]);
  const ids = s.frame().map((w) => w.id);
  assert.equal(s.commit("Hello world."), true);
  assert.deepEqual(s.frame().map((w) => w.text), ["Hello", "world."]);
  assert.deepEqual(s.frame().map((w) => w.id), ids); // stable DOM identity
  assert.ok(s.frame().every((w) => w.state === "final"));
  assert.equal(s.commit("Hello world."), false); // timestamped duplicate event
  s.partial("how are");
  s.partial("how are you");
  assert.equal(s.commit("how are you"), true);
  assert.equal(s.committedText(), "Hello world. how are you");
});

test("SttSyncController corrections shrink partials and reset starts new epoch", () => {
  const s = new SttSyncController("en");
  s.partial("a b c");
  s.partial("a b");
  assert.deepEqual(s.frame().map((w) => w.text), ["a", "b"]);
  const before = s.frame()[0].id;
  s.reset();
  s.partial("a");
  assert.notEqual(s.frame()[0].id, before);
  assert.equal(s.commit("ok"), true);
});

import { TtsAlignmentTracker, parseAlignmentEvent } from "../lib/kinetic/tts-align-client.ts";
import { TimestampedTtsSession } from "../lib/timestamped-tts-session.ts";
import { parseTimestampLines } from "../lib/elevenlabs-timestamps.ts";

test("tracker withholds trailing partial word until boundary/sentence-end and preserves spacing", () => {
  const t = new TtsAlignmentTracker("th");
  const mk = (sentence, text, at) => parseAlignmentEvent({
    turnId: "t", sentence, chars: [...text],
    starts: [...text].map((_, i) => at + i * 0.1), ends: [...text].map((_, i) => at + (i + 1) * 0.1),
  });
  // First chunk ends mid-word ("โ" of "โอเค") -> not emitted prematurely
  assert.deepEqual(t.ingest(mk(0, "เดี๋ยวนะ โ", 0)).map((w) => [w.text, w.spaceBefore]), [
    ["เดี๋ยว", false],
    ["นะ", false],
  ]);
  // Rest of word arrives + sentence finishes -> "โอเค" emitted whole with spaceBefore: true
  t.ingest(mk(0, "อเค", 1.0));
  const done = t.markSentenceEnd(0);
  assert.deepEqual(done.map((w) => [w.id, w.text, w.spaceBefore]), [
    ["s0-0", "เดี๋ยว", false],
    ["s0-1", "นะ", false],
    ["s0-2", "โอเค", true],
  ]);
  const ctl = new TtsSyncController();
  ctl.startTurn("t");
  ctl.addWords("t", done);
  assert.deepEqual(ctl.frame(0.1).map((w) => w.text), ["เดี๋ยว"]);
  assert.deepEqual(ctl.frame(1.1).map((w) => [w.text, w.spaceBefore]), [
    ["เดี๋ยว", false],
    ["นะ", false],
    ["โอเค", true],
  ]);
});

test("parseTimestampLines handles split JSON lines", () => {
  const line = JSON.stringify({ audio_base64: "AAAA", alignment: null });
  const a = parseTimestampLines(line.slice(0, 10));
  assert.equal(a.messages.length, 0);
  const b = parseTimestampLines(`${a.rest}${line.slice(10)}\n${line}\n`);
  assert.equal(b.messages.length, 2);
});

function pcmB64(seconds) {
  return Buffer.alloc(Math.round(seconds * 24000) * 2).toString("base64");
}

test("TimestampedTtsSession emits ordered chunks and turn-timeline alignment", async () => {
  const events = [];
  const durations = { first: 0.5, second: 0.5 };
  const stream = async function* ({ text }) {
    const key = text.includes("One") ? "first" : "second";
    const chars = [...text];
    // Two chunk-relative messages per phrase.
    const half = Math.ceil(chars.length / 2);
    for (const part of [chars.slice(0, half), chars.slice(half)]) {
      yield {
        audio: pcmB64(durations[key] / 2),
        alignment: { characters: part, character_start_times_seconds: part.map((_, i) => i * 0.01), character_end_times_seconds: part.map((_, i) => (i + 1) * 0.01) },
      };
    }
  };
  const s = new TimestampedTtsSession({ apiKey: "k", voiceId: "v", language: "en", turnId: "t:0", emit: (e) => events.push(e), stream });
  s.pushDelta("One two three. Second sentence here.");
  await s.finish();
  const chunks = events.filter((e) => e.event === "audio_chunk");
  assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i));
  const align = events.filter((e) => e.event === "audio_alignment");
  assert.ok(align.length >= 2);
  const sentences = [...new Set(align.map((a) => a.sentence))];
  assert.ok(sentences.length >= 2);
  const firstOfSecond = align.find((a) => a.sentence === sentences[1]);
  assert.ok(firstOfSecond.starts[0] >= 0.49, `second sentence offset ${firstOfSecond.starts[0]}`);
  // monotonic across the turn
  const all = align.flatMap((a) => a.starts);
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i] >= all[i - 1] - 1e-9);
  assert.equal(events.at(-1).event, "audio_turn_end");
});

test("TimestampedTtsSession reports stream failures as audio_error", async () => {
  const events = [];
  const stream = async function* () { throw new Error("boom"); };
  const s = new TimestampedTtsSession({ apiKey: "k", voiceId: "v", language: "en", turnId: "t:0", emit: (e) => events.push(e), stream });
  s.pushDelta("Hello there.");
  await s.finish();
  assert.equal(events.at(-1).event, "audio_error");
  assert.equal(events.at(-1).audioStarted, false);
});

import { ScribeRealtimeClient, buildScribeUrl } from "../lib/scribe-realtime.ts";
import { Downsampler } from "../lib/pcm-capture.ts";

class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  say(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("Scribe URL carries token, manual commit and timestamps", () => {
  const u = new URL(buildScribeUrl("tok", "th"));
  assert.equal(u.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(u.searchParams.get("include_timestamps"), "true");
  assert.equal(u.searchParams.get("language_code"), "th");
  assert.equal(buildScribeUrl("t", "xx").includes("language_code"), false);
});

test("Scribe client buffers audio until open, then commits and resolves", async () => {
  const sockets = [];
  const events = [];
  const c = new ScribeRealtimeClient({
    fetchToken: async () => "tok",
    language: "en",
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    callbacks: { onPartial: (t) => events.push(["p", t]), onCommitted: (t) => events.push(["c", t]) },
  });
  c.start();
  c.sendAudio(new Int16Array(1600));
  await tick();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 0);
  sockets[0].open();
  assert.equal(sockets[0].sent.length, 1);
  sockets[0].say({ message_type: "partial_transcript", text: "hello" });
  sockets[0].say({ message_type: "partial_transcript", text: "hello" }); // deduped
  const pending = c.commit(500);
  assert.equal(sockets[0].sent.at(-1).commit, true);
  sockets[0].say({ message_type: "committed_transcript", text: "hello world" });
  assert.equal(await pending, "hello world");
  assert.deepEqual(events, [["p", "hello"], ["c", "hello world"]]);
  c.stop();
});

test("Scribe client replays audio into a new session after a drop", async () => {
  const sockets = [];
  const c = new ScribeRealtimeClient({
    fetchToken: async () => "tok",
    backoffMs: () => 1,
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    callbacks: { onPartial() {}, onCommitted() {} },
  });
  c.start();
  await tick();
  sockets[0].open();
  c.sendAudio(new Int16Array(1600));
  c.sendAudio(new Int16Array(1600));
  const pending = c.commit(1000);
  sockets[0].drop();
  await tick(30);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  const audioMsgs = sockets[1].sent.filter((m) => m.message_type === "input_audio_chunk");
  assert.equal(audioMsgs.length, 3); // 2 replayed chunks + commit chunk
  assert.equal(audioMsgs.at(-1).commit, true);
  sockets[1].say({ message_type: "committed_transcript", text: "ok" });
  assert.equal(await pending, "ok");
});

test("Scribe client fails over (null) when reconnects are exhausted or an error arrives", async () => {
  const sockets = [];
  const c = new ScribeRealtimeClient({
    fetchToken: async () => "tok", backoffMs: () => 1, maxReconnects: 1,
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    callbacks: { onPartial() {}, onCommitted() {} },
  });
  c.start(); await tick();
  const pending = c.commit(1000);
  sockets[0].drop(); await tick(20);
  sockets[1].drop(); await tick(20);
  assert.equal(await pending, null);
  assert.equal(c.healthy, false);

  const c2 = new ScribeRealtimeClient({
    fetchToken: async () => "tok",
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    callbacks: { onPartial() {}, onCommitted() {} },
  });
  c2.start(); await tick();
  const sock = sockets.at(-1); sock.open();
  const p2 = c2.commit(1000);
  sock.say({ message_type: "quota_exceeded", error: "x" });
  assert.equal(await p2, null);
});

test("Downsampler converts 48 kHz float audio to 16 kHz PCM16", () => {
  const d = new Downsampler(48000);
  const out = d.push(new Float32Array(4800).fill(0.5));
  assert.equal(out.length, 1600);
  assert.ok(Math.abs(out[0] - 16384) < 2);
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { KineticStore } from "../lib/kinetic/types.ts";
import { AudioStreamingManager } from "../lib/audio-streaming.ts";

test("SttSyncController uses ordered timestamped words and preserves mixed Thai-English spacing", () => {
  const s = new SttSyncController("th");
  s.partial("สวัสดีค่ะ hello");
  assert.equal(s.commit("สวัสดีค่ะ hello", [
    { text: "hello", start: 0.4, end: 0.8, type: "word" },
    { text: "สวัสดีค่ะ ", start: 0.0, end: 0.4, type: "word" },
  ]), true);
  assert.equal(s.commit("สวัสดีค่ะ hello", [
    { text: "สวัสดีค่ะ ", start: 0.0, end: 0.4, type: "word" },
    { text: "hello", start: 0.4, end: 0.8, type: "word" },
  ]), false);
  assert.equal(s.committedText(), "สวัสดีค่ะ hello");

  // Handles timestamp-only commit event when text is omitted
  const s2 = new SttSyncController("en");
  assert.equal(s2.commit("", [
    { text: "world", start: 0.5, end: 0.9, type: "word" },
    { text: "hello ", start: 0.1, end: 0.4, type: "word" },
  ]), true);
  assert.equal(s2.committedText(), "hello world");
});

test("KineticStore notifies listeners only when words or states change", () => {
  const store = new KineticStore();
  let notifications = 0;
  const unsub = store.subscribe(() => { notifications += 1; });
  store.set([{ id: "w0", text: "hi", state: "active" }]);
  store.set([{ id: "w0", text: "hi", state: "active" }]);
  store.set([{ id: "w0", text: "hi", state: "past" }]);
  unsub();
  store.clear();
  assert.equal(notifications, 2);
});

test("AudioStreamingManager tracks playback position across chunks without advancing during underrun gaps", async () => {
  const ctx = {
    state: "running",
    currentTime: 10,
    sampleRate: 24000,
    destination: {},
    async resume() {},
    createBuffer(_ch, len, sr) {
      const buf = new Float32Array(len);
      return { duration: len / sr, getChannelData: () => buf };
    },
    createBufferSource() {
      return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
    },
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
    createAnalyser() { return { fftSize: 256, smoothingTimeConstant: 0.7, connect() {}, disconnect() {} }; },
  };
  const mgr = new AudioStreamingManager();
  mgr.startTurn("turn-1", ctx);
  assert.equal(mgr.getPlaybackPositionSec(), null);

  // Chunk 0 (0.1s) and Chunk 1 (0.1s) meet pre-buffer threshold -> scheduled at 10.025s and 10.125s
  const chunk = pcmB64(0.1);
  mgr.enqueueChunk({ turnId: "turn-1", seq: 0, audio: chunk, sampleRate: 24000 });
  mgr.enqueueChunk({ turnId: "turn-1", seq: 1, audio: chunk, sampleRate: 24000 });
  await new Promise((r) => setTimeout(r, 15));

  ctx.currentTime = 10.0;
  assert.equal(mgr.getPlaybackPositionSec(), null);

  ctx.currentTime = 10.075;
  assert.ok(Math.abs(mgr.getPlaybackPositionSec() - 0.04) < 1e-6);

  // Simulate an underrun gap after chunk 1 ends (10.225s) before chunk 2 arrives at 11.0s
  ctx.currentTime = 11.0;
  mgr.enqueueChunk({ turnId: "turn-1", seq: 2, audio: chunk, sampleRate: 24000 });
  await new Promise((r) => setTimeout(r, 15));
  // Chunk 2 starts at 11.015s; at 11.065s content cursor should be 0.2 + 0.05 = 0.25s (gap excluded)
  ctx.currentTime = 11.065;
  assert.ok(Math.abs(mgr.getPlaybackPositionSec() - 0.25) < 1e-6);

  mgr.interrupt();
  assert.equal(mgr.getPlaybackPositionSec(), null);
});

test("/api/stt/token mints single-use token server-side and checks auth, rate limit, and key", async () => {
  const require = createRequire(import.meta.url);
  const source = ts.transpileModule(
    readFileSync(new URL("../app/api/stt/token/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;

  const callRoute = (fetchImpl, { key = "secret-el-key", denied = null, limited = false } = {}) => {
    const exports = {};
    runInNewContext(source, {
      exports,
      fetch: fetchImpl,
      Response,
      AbortSignal,
      process: { env: { ELEVENLABS_API_KEY: key } },
      console: { warn() {} },
      require(name) {
        if (name === "@/lib/auth/server") return { requireApiAccess: async () => denied };
        if (name === "@/lib/rate-limit") return { rateLimit: () => ({ allowed: !limited, retryAfter: 10 }), rateLimitedResponse: () => Response.json({ error: "limit" }, { status: 429 }) };
        if (name === "next/server") return require("next/server");
        throw Error(name);
      },
    });
    return exports.POST(new Request("https://vivian.example/api/stt/token", { method: "POST" }));
  };

  const okRes = await callRoute(async (url, opts) => {
    assert.equal(url, "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    assert.equal(opts.headers["xi-api-key"], "secret-el-key");
    return Response.json({ token: "sutok_123" });
  });
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { token: "sutok_123" });

  assert.equal((await callRoute(async () => assert.fail(), { denied: Response.json({}, { status: 401 }) })).status, 401);
  assert.equal((await callRoute(async () => assert.fail(), { limited: true })).status, 429);
  assert.equal((await callRoute(async () => assert.fail(), { key: "" })).status, 500);
  assert.equal((await callRoute(async () => new Response("fail", { status: 503 }))).status, 502);
});
