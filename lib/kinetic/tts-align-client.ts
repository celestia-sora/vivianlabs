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
 * words. While a sentence is still receiving chunks, its trailing word is held
 * back so a word split across stream chunks (e.g. "โ" then "อเค") never
 * renders half-cut; it flushes as soon as the next word, next sentence, or
 * `markSentenceEnd` / `flushAll` arrives.
 */
export class TtsAlignmentTracker {
  private sentences = new Map<number, TimedChar[]>();
  private completed = new Set<number>();
  private language: string;

  constructor(language = "th") { this.language = language; }
  setLanguage(language: string): void { this.language = language; }
  reset(): void { this.sentences.clear(); this.completed.clear(); }

  private build(sentence: number): WordTiming[] {
    const list = this.sentences.get(sentence);
    if (!list?.length) return [];
    const words = wordsFromTimedChars(list, this.language, `s${sentence}-`);
    if (this.completed.has(sentence)) {
      // Ensure a space separates consecutive sentences when the stream omitted one.
      if (sentence > 0 && words.length > 0 && !words[0].spaceBefore) {
        words[0] = { ...words[0], spaceBefore: true };
      }
      return words;
    }
    const ready = words.length > 1 ? words.slice(0, -1) : [];
    if (sentence > 0 && ready.length > 0 && !ready[0].spaceBefore) {
      ready[0] = { ...ready[0], spaceBefore: true };
    }
    return ready;
  }

  ingest(event: AudioAlignmentEvent): WordTiming[] {
    const out: WordTiming[] = [];
    for (const prev of this.sentences.keys()) {
      if (prev < event.sentence && !this.completed.has(prev)) {
        this.completed.add(prev);
        out.push(...this.build(prev));
      }
    }
    const list = this.sentences.get(event.sentence) ?? [];
    for (let i = 0; i < event.chars.length; i += 1) list.push({ char: event.chars[i], start: event.starts[i], end: event.ends[i] });
    this.sentences.set(event.sentence, list);
    out.push(...this.build(event.sentence));
    return out;
  }

  markSentenceEnd(sentence: number): WordTiming[] {
    if (this.completed.has(sentence)) return [];
    this.completed.add(sentence);
    return this.build(sentence);
  }

  flushAll(): WordTiming[] {
    const out: WordTiming[] = [];
    const keys = [...this.sentences.keys()].sort((a, b) => a - b);
    for (const s of keys) {
      if (!this.completed.has(s)) {
        this.completed.add(s);
        out.push(...this.build(s));
      }
    }
    return out;
  }
}
