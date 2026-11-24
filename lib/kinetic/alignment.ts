import type { TimedChar } from "./segment.ts";

export interface RawAlignment {
  characters?: unknown;
  character_start_times_seconds?: unknown;
  character_end_times_seconds?: unknown;
}

/** Validates an ElevenLabs alignment object; returns null when unusable. */
export function parseAlignment(raw: unknown): { chars: string[]; starts: number[]; ends: number[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as RawAlignment;
  if (!Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) return null;
  const n = Math.min(a.characters.length, a.character_start_times_seconds.length, a.character_end_times_seconds.length);
  if (n === 0) return null;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = a.characters[i];
    const s = a.character_start_times_seconds[i];
    const e = a.character_end_times_seconds[i];
    if (typeof c !== "string" || typeof s !== "number" || typeof e !== "number" || !Number.isFinite(s) || !Number.isFinite(e)) return null;
    chars.push(c); starts.push(s); ends.push(e);
  }
  return { chars, starts, ends };
}

/**
 * Converts per-chunk alignment into times on one continuous audio timeline.
 *
 * ElevenLabs may report times relative to the start of each streamed chunk
 * (observed on Text-to-Dialogue) or cumulative from the start of the request.
 * We detect which by checking whether a chunk's first character starts before
 * the previous chunk's last end, and add the audio duration already emitted
 * when it is chunk-relative. `timelineOffsetSec` places the whole sentence on
 * the turn timeline (audio seconds emitted by earlier sentences).
 */
export class AlignmentAccumulator {
  private lastEnd = 0;
  private lastStart = 0;
  private audioSec = 0;
  private readonly timelineOffsetSec: number;
  private emitted = 0;

  constructor(timelineOffsetSec = 0) {
    this.timelineOffsetSec = timelineOffsetSec;
  }

  /** Total decoded audio duration (seconds) seen so far for this sentence. */
  get audioDurationSec(): number { return this.audioSec; }
  get charCount(): number { return this.emitted; }

  /**
   * Adds one stream message. `chunkDurationSec` is the decoded duration of the
   * audio carried by the same message (0 when none). Returns turn-timeline
   * characters produced by this message.
   */
  push(raw: unknown, chunkDurationSec: number): TimedChar[] {
    const parsed = parseAlignment(raw);
    const out: TimedChar[] = [];
    if (parsed) {
      const firstStart = parsed.starts[0];
      const relative = this.emitted > 0 && firstStart + 0.02 < this.lastEnd;
      const shift = (relative ? this.audioSec : 0) + this.timelineOffsetSec;
      for (let i = 0; i < parsed.chars.length; i += 1) {
        const start = Math.max(this.lastStart, parsed.starts[i] + shift);
        const end = Math.max(start, parsed.ends[i] + shift);
        out.push({ char: parsed.chars[i], start, end });
        this.lastStart = start;
        this.lastEnd = Math.max(this.lastEnd, end);
      }
      this.emitted += out.length;
    }
    if (Number.isFinite(chunkDurationSec) && chunkDurationSec > 0) this.audioSec += chunkDurationSec;
    return out;
  }
}

/** Duration of raw PCM16 mono audio in seconds. */
export function pcm16DurationSec(byteLength: number, sampleRate: number): number {
  return byteLength / 2 / sampleRate;
}
