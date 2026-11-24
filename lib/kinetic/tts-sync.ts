import type { WordTiming } from "./segment.ts";
import { windowWords, type KineticWord } from "./types.ts";

/**
 * TTS synchronization controller. Its only clock is the audio playback
 * position (seconds on the turn's audio timeline) supplied by the caller; it
 * never uses timers, and it is independent of the STT controller.
 */
export class TtsSyncController {
  private words: WordTiming[] = [];
  private turnId: string | null = null;
  private ended = false;

  get currentTurnId(): string | null { return this.turnId; }
  get isEnded(): boolean { return this.ended; }
  get wordCount(): number { return this.words.length; }

  startTurn(turnId: string): void {
    this.turnId = turnId;
    this.words = [];
    this.ended = false;
  }

  /**
   * Adds or updates timed words for a turn (matched by id, so a trailing word
   * that grows as more characters arrive is updated in place). Stale turns are
   * ignored and start times never run backwards.
   */
  addWords(turnId: string, words: readonly WordTiming[]): void {
    if (turnId !== this.turnId) return;
    for (const w of words) {
      const existing = this.words.findIndex((x) => x.id === w.id);
      if (existing >= 0) { this.words[existing] = { ...w, startSec: this.words[existing].startSec }; continue; }
      const prev = this.words[this.words.length - 1];
      this.words.push(prev && w.startSec < prev.startSec ? { ...w, startSec: prev.startSec, endSec: Math.max(prev.startSec, w.endSec) } : w);
    }
  }

  /** Reset after an audio_reset (retry) so words are re-sent from the top. */
  resetAttempt(turnId: string): void {
    if (turnId === this.turnId) { this.words = []; this.ended = false; }
  }

  end(turnId: string): void { if (turnId === this.turnId) this.ended = true; }

  interrupt(): void {
    this.turnId = null;
    this.words = [];
    this.ended = false;
  }

  /** Words revealed at `positionSec`, windowed, with emphasis states. */
  frame(positionSec: number | null, windowSize?: number): KineticWord[] {
    if (positionSec === null || this.words.length === 0) return [];
    let revealed = 0;
    while (revealed < this.words.length && this.words[revealed].startSec <= positionSec) revealed += 1;
    if (revealed === 0) return [];
    const out: KineticWord[] = [];
    for (let i = 0; i < revealed; i += 1) {
      const w = this.words[i];
      const isLast = i === revealed - 1;
      out.push({ id: w.id, text: w.text, state: isLast && positionSec < w.endSec + 0.25 ? "active" : "past" });
    }
    return windowWords(out, windowSize);
  }

  /** True once every word has been revealed and played out. */
  isFinished(positionSec: number | null): boolean {
    if (!this.ended || positionSec === null) return false;
    const last = this.words[this.words.length - 1];
    return !last || positionSec >= last.endSec;
  }
}
