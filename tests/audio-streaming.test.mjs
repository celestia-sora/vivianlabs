import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioStreamingManager, pcm16LeToFloat32 } from "../lib/audio-streaming.ts";

class MockAudioContext {
  state = "running";
  currentTime = 1.0;
  sampleRate = 48000;
  destination = { kind: "destination" };
  scheduled = [];

  async resume() {
    this.state = "running";
  }

  createBuffer(_channels, length, sampleRate) {
    const channelData = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channelData,
    };
  }

  createBufferSource() {
    const node = {
      buffer: null,
      onended: null,
      startedAt: null,
      stopped: false,
      disconnected: false,
      connect() {},
      disconnect() {
        node.disconnected = true;
      },
      start: (when = 0) => {
        node.startedAt = when;
        this.scheduled.push(node);
      },
      stop() {
        node.stopped = true;
      },
      triggerEnded() {
        node.onended?.();
      },
    };
    return node;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }

  createAnalyser() {
    return {
      fftSize: 256,
      smoothingTimeConstant: 0.72,
      frequencyBinCount: 128,
      connect() {},
      disconnect() {},
      getByteTimeDomainData() {},
      getByteFrequencyData() {},
    };
  }
}

function pcmBase64(sampleCount, value = 1000) {
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) {
    view.setInt16(i * 2, value, true);
  }
  return Buffer.from(bytes).toString("base64");
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("pcm16LeToFloat32 converts signed 16-bit LE samples accurately", () => {
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0x80]);
  const f32 = pcm16LeToFloat32(bytes);
  assert.equal(f32.length, 3);
  assert.equal(f32[0], 0);
  assert.ok(Math.abs(f32[1] - 0.5) < 1e-4);
  assert.equal(f32[2], -1);
});

test("reorders out-of-order chunks, drops duplicates, schedules gaplessly, and completes after final source ends", async () => {
  const ctx = new MockAudioContext();
  let startedCount = 0;
  let endedMetrics = null;
  const manager = new AudioStreamingManager({
    onPlaybackStart: () => { startedCount++; },
    onPlaybackEnd: (m) => { endedMetrics = m; },
  });

  manager.startTurn("turn-a", ctx);

  // 1200 samples = 50ms at 24kHz
  const chunk0 = pcmBase64(1200, 500);
  const chunk1 = pcmBase64(1200, 1500);

  // Chunk 1 arrives before chunk 0, plus a duplicate of chunk 1
  assert.equal(manager.enqueueChunk({ turnId: "turn-a:0", seq: 1, audio: chunk1 }), true);
  assert.equal(manager.enqueueChunk({ turnId: "turn-a:0", seq: 1, audio: chunk1 }), false);
  await tick();
  assert.equal(ctx.scheduled.length, 0, "must wait for seq 0 before playing seq 1");

  // Chunk 0 arrives -> chunk 0 starts immediately BEFORE markTurnComplete, and chunk 1 schedules right behind it
  assert.equal(manager.enqueueChunk({ turnId: "turn-a:0", seq: 0, audio: chunk0 }), true);
  const startWait = await manager.waitForPlaybackStart();
  assert.deepEqual(startWait, { started: true, interrupted: false });
  assert.equal(startedCount, 1);
  await tick();
  assert.equal(ctx.scheduled.length, 2);

  // Verify exact gapless boundary: source[1].startedAt === source[0].startedAt + source[0].buffer.duration
  const s0 = ctx.scheduled[0];
  const s1 = ctx.scheduled[1];
  assert.ok(Math.abs(s1.startedAt - (s0.startedAt + s0.buffer.duration)) < 1e-9);
  assert.equal(s0.buffer.getChannelData(0)[0] < s1.buffer.getChannelData(0)[0], true);

  manager.markTurnComplete("turn-a:0");
  await tick();
  assert.equal(endedMetrics, null, "must not mark turn complete while scheduled audio is still playing");

  s0.triggerEnded();
  assert.equal(endedMetrics, null);
  s1.triggerEnded();
  assert.ok(endedMetrics !== null);
  assert.equal(endedMetrics.chunkCount, 2);
  assert.equal(endedMetrics.playbackGaps, 0);
});

test("odd-byte PCM chunks merge cleanly across chunk boundaries", async () => {
  const ctx = new MockAudioContext();
  const manager = new AudioStreamingManager();
  manager.startTurn("turn-odd", ctx);

  // 2001 bytes -> odd byte splits a sample across chunk 0 and chunk 1
  const full = new Uint8Array(2002);
  for (let i = 0; i < 1001; i++) {
    new DataView(full.buffer).setInt16(i * 2, 2048, true);
  }
  const part0 = Buffer.from(full.subarray(0, 1999)).toString("base64");
  const part1 = Buffer.from(full.subarray(1999)).toString("base64");

  manager.enqueueChunk({ turnId: "turn-odd:0", seq: 0, audio: part0 });
  manager.enqueueChunk({ turnId: "turn-odd:0", seq: 1, audio: part1 });
  manager.markTurnComplete("turn-odd:0");
  await tick();

  assert.equal(ctx.scheduled.length, 2);
  const totalSamples =
    ctx.scheduled[0].buffer.getChannelData(0).length +
    ctx.scheduled[1].buffer.getChannelData(0).length;
  assert.equal(totalSamples, 1001);
});

test("rapid interruption stops active sources immediately and blocks stale chunks from leaking into new conversations", async () => {
  const ctx = new MockAudioContext();
  let interrupted = 0;
  const manager = new AudioStreamingManager({
    onInterrupt: () => { interrupted++; },
  });

  manager.startTurn("conv-1-turn", ctx);
  manager.enqueueChunk({ turnId: "conv-1-turn:0", seq: 0, audio: pcmBase64(2400) });
  await manager.waitForPlaybackStart();
  assert.equal(ctx.scheduled.length, 1);

  const metrics = manager.interrupt();
  assert.equal(interrupted, 1);
  assert.equal(ctx.scheduled[0].stopped, true);
  assert.ok(typeof metrics.interruptLatencyMs === "number" && metrics.interruptLatencyMs >= 0);

  // Late chunk from conv-1 must be rejected
  assert.equal(manager.enqueueChunk({ turnId: "conv-1-turn:0", seq: 1, audio: pcmBase64(2400) }), false);

  // Start a new conversation turn; conv-1 chunks still rejected
  manager.startTurn("conv-2-turn", ctx);
  assert.equal(manager.enqueueChunk({ turnId: "conv-1-turn:0", seq: 2, audio: pcmBase64(2400) }), false);
  assert.equal(manager.enqueueChunk({ turnId: "conv-2-turn:0", seq: 0, audio: pcmBase64(2400) }), true);
  await manager.waitForPlaybackStart();
  assert.equal(ctx.scheduled.length, 2);
});

test("network underrun increments playbackGaps and errors distinguish pre-playback vs mid-playback", async () => {
  const ctx = new MockAudioContext();
  const errors = [];
  const manager = new AudioStreamingManager({
    onError: (turnId, _err, audioStarted) => errors.push({ turnId, audioStarted }),
  });

  // 1. Failure before any audio started -> audioStarted = false (safe to fall back)
  manager.startTurn("turn-fail-early", ctx);
  manager.markTurnError("turn-fail-early:0", "ws failed");
  const waitFail = await manager.waitForPlaybackStart();
  assert.deepEqual(waitFail, { started: false, interrupted: false });
  assert.deepEqual(errors[0], { turnId: "turn-fail-early:0", audioStarted: false });

  // 2. Underrun then mid-stream failure -> audioStarted = true (must NOT trigger fallback)
  manager.startTurn("turn-gap", ctx);
  manager.enqueueChunk({ turnId: "turn-gap:0", seq: 0, audio: pcmBase64(1200) });
  await manager.waitForPlaybackStart();

  // Advance clock past chunk 0 end time to simulate network stall
  ctx.currentTime += 0.5;
  manager.enqueueChunk({ turnId: "turn-gap:0", seq: 1, audio: pcmBase64(1200) });
  await tick();
  assert.equal(manager.getMetrics().playbackGaps, 1);

  manager.markTurnError("turn-gap:0", "socket closed mid-turn");
  assert.deepEqual(errors[1], { turnId: "turn-gap:0", audioStarted: true });
});
