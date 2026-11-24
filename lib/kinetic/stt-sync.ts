import { segmentText } from "./segment.ts";
import { windowWords, type KineticWord } from "./types.ts";

export interface SttTimedWord {
  text: string;
  start: number;
  end: number;
  type?: string;
}

function norm(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * STT synchronization controller. Driven purely by Scribe transcript events
 * (partial / committed / committed_with_timestamps) — it has no playback clock
 * and shares nothing with the TTS controller. Word ids are positional
 * (`w<epoch>-<n>`), so a word keeps the same DOM element when a partial is
 * corrected or later committed; corrections therefore never duplicate words.
 */
export class SttSyncController {
  private committed: string[] = [];
  private rawCommitted: string[] = [];
  private partialWords: string[] = [];
  private epoch = 0;
  private language: string;
  private lastCommitKey = "";
  private partialSinceCommit = true;

  constructor(language = "th") { this.language = language; }

  setLanguage(language: string): void { this.language = language; }

  /** Replaces the uncommitted tail with the latest partial transcript. */
  partial(text: string): void {
    this.partialWords = segmentText(text, this.language);
    this.partialSinceCommit = true;
  }

  /**
   * Freezes a committed segment, using ordered word timestamps when provided.
   * A repeated commit of identical text with no partial in between (Scribe
   * emits both `committed_transcript` and `committed_transcript_with_timestamps`)
   * is ignored so words are never duplicated.
   */
  commit(text: string, words?: readonly SttTimedWord[]): boolean {
    const orderedText =
      text.trim() ||
      (words?.length
        ? [...words].sort((a, b) => a.start - b.start).map((w) => w.text).join("")
        : "");
    const key = norm(orderedText);
    if (!key) { this.partialWords = []; return false; }
    if (key === this.lastCommitKey && !this.partialSinceCommit) { this.partialWords = []; return false; }
    this.committed.push(...segmentText(orderedText, this.language));
    this.rawCommitted.push(orderedText.trim());
    this.partialWords = [];
    this.lastCommitKey = key;
    this.partialSinceCommit = false;
    return true;
  }

  /** Full committed text of the current utterance (for submission). */
  committedText(): string {
    return this.rawCommitted.join(" ").trim();
  }

  reset(): void {
    this.committed = [];
    this.rawCommitted = [];
    this.partialWords = [];
    this.epoch += 1;
    this.lastCommitKey = "";
    this.partialSinceCommit = true;
  }

  frame(windowSize?: number): KineticWord[] {
    const out: KineticWord[] = [];
    this.committed.forEach((text, i) => out.push({ id: `w${this.epoch}-${i}`, text, state: "final" }));
    const base = this.committed.length;
    this.partialWords.forEach((text, i) => {
      const last = i === this.partialWords.length - 1;
      out.push({ id: `w${this.epoch}-${base + i}`, text, state: last ? "active" : "incoming" });
    });
    return windowWords(out, windowSize);
  }
}
