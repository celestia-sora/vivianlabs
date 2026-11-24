import { wordsFromTimedChars, type TimedChar, type WordTiming } from "./segment.ts";

export interface AudioAlignmentEvent {
  turnId: string;
  sentence: number;
  chars: string[];
  starts: number[];
  ends: number[];
}

export function parseAlignmentEvent(event: Record<string, unknown>): AudioAlignmentEvent | null {
  const { chars, starts, ends } = event;
  if (typeof event.turnId !== "string" || typeof event.sentence !== "number") return null;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  const n = Math.min(chars.length, starts.length, ends.length);
  if (n === 0) return null;
  for (let i = 0; i < n; i += 1) {
    if (typeof chars[i] !== "string" || typeof starts[i] !== "number" || typeof ends[i] !== "number") return null;
  }
  return { turnId: event.turnId, sentence: event.sentence, chars: chars.slice(0, n) as string[], starts: starts.slice(0, n) as number[], ends: ends.slice(0, n) as number[] };
}

/**
 * Accumulates streamed characters per sentence and regroups them into timed
 * words each time more arrive. A word split across two stream messages is
 * therefore rebuilt whole; ids (`s<sentence>-<n>`) are stable.
 */
export class TtsAlignmentTracker {
  private sentences = new Map<number, TimedChar[]>();
  private language: string;

  constructor(language = "th") { this.language = language; }
  setLanguage(language: string): void { this.language = language; }
  reset(): void { this.sentences.clear(); }

  ingest(event: AudioAlignmentEvent): WordTiming[] {
    const list = this.sentences.get(event.sentence) ?? [];
    for (let i = 0; i < event.chars.length; i += 1) list.push({ char: event.chars[i], start: event.starts[i], end: event.ends[i] });
    this.sentences.set(event.sentence, list);
    return wordsFromTimedChars(list, this.language, `s${event.sentence}-`);
  }
}
