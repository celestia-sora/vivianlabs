/** Box-filter downsampler from an arbitrary input rate to 16-bit PCM mono. */
export class Downsampler {
  private readonly ratio: number;
  readonly outputRate: number;
  private acc = 0;
  private count = 0;
  private pos = 0; // fractional input samples consumed toward the next output

  constructor(inputRate: number, outputRate = 16_000) {
    this.outputRate = outputRate;
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Int16Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1) {
      this.acc += input[i];
      this.count += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        const v = Math.max(-1, Math.min(1, this.acc / this.count));
        out.push(v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff));
        this.pos -= this.ratio;
        this.acc = 0;
        this.count = 0;
      }
    }
    return Int16Array.from(out);
  }
}

const WORKLET_SOURCE = `
class VivianPcm extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; }
}
registerProcessor("vivian-pcm", VivianPcm);
`;

export interface PcmCapture { stop(): void }

/**
 * Taps a microphone MediaStream and delivers ~100 ms chunks of 16 kHz PCM16.
 * Uses an AudioWorklet where available, otherwise a ScriptProcessor.
 */
export async function startPcmCapture(stream: MediaStream, onChunk: (pcm: Int16Array) => void): Promise<PcmCapture> {
  const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  const ctx = new Ctor();
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  const down = new Downsampler(ctx.sampleRate);
  let pending: Int16Array[] = [];
  let pendingLen = 0;
  const emit = (floats: Float32Array) => {
    const pcm = down.push(floats);
    if (!pcm.length) return;
    pending.push(pcm); pendingLen += pcm.length;
    if (pendingLen >= 1600) {
      const merged = new Int16Array(pendingLen);
      let o = 0;
      for (const p of pending) { merged.set(p, o); o += p.length; }
      pending = []; pendingLen = 0;
      onChunk(merged);
    }
  };
  let node: AudioNode | null = null;
  let objectUrl: string | null = null;
  try {
    if (!ctx.audioWorklet) throw new Error("no worklet");
    objectUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(objectUrl);
    const worklet = new AudioWorkletNode(ctx, "vivian-pcm");
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data);
    source.connect(worklet);
    worklet.connect(sink);
    node = worklet;
  } catch {
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => emit(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor);
    processor.connect(sink);
    node = processor;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
  return {
    stop() {
      try { source.disconnect(); } catch { /* ignore */ }
      try { node?.disconnect(); } catch { /* ignore */ }
      void ctx.close().catch(() => {});
    },
  };
}
