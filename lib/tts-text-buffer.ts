import {
  replyCharacterLimit,
  speechText,
  speechTextWithAudioTags,
  hasStandaloneAudioEventTag,
} from "./speech.ts";

export interface TtsPhraseSegment {
  /** Sanitized text with preserved inline ElevenLabs v4 audio tags. */
  taggedText: string;
  /** Plain spoken text (tags stripped) for validation/metrics. */
  cleanText: string;
  /** Zero-based segment index in the current turn. */
  index: number;
  /** True when this is the first spoken segment of the turn. */
  isFirst: boolean;
  /** Whether to instruct ElevenLabs WebSocket to flush immediately. */
  flush: boolean;
}

export interface TtsTextBufferOptions {
  language?: string;
  maxVisibleChars?: number;
  /** Minimum spoken chars before splitting on a soft boundary (space/comma) for segment 0. */
  firstSoftMinChars?: number;
  /** Minimum spoken chars before splitting on a soft boundary (space/comma) for subsequent segments. */
  softMinChars?: number;
  /** Force a word-boundary split on segment 0 if unpunctuated text reaches this length. */
  firstMaxSegmentChars?: number;
  /** Force a word-boundary split if a single unpunctuated run reaches this length. */
  maxSegmentChars?: number;
}

const CITATION_MARKER = /\n\s*(?:แหล่งข้อมูล|sources)\s*:/i;
const TRAILING_STAMMER = /(?:^|[^\p{L}\p{M}\p{N}])[\p{L}\p{M}]{1,12}\s*[-‐‑‒–—]\s*$/u;
const TRAILING_NUMBER_FRAGMENT = /(?:^|\s)-?\d[\d,.]*$/u;
const TIME_ABBREV_AT = /(?:^|\s)(?:[01]?\d|2[0-3]):[0-5]\d\s*น\.$/u;
const HAS_THAI = /[ก-๙]/u;

const thaiWordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;

/**
 * Checks whether index `pos` (pointing right after a candidate boundary char)
 * sits inside an open bracket, parenthesis, code fence, markdown link, or URL.
 */
function isInsideUnclosedStructure(text: string, endExclusive: number): boolean {
  let squareDepth = 0;
  let parenDepth = 0;
  let inCodeFence = false;
  let inInlineCode = false;
  let starCount = 0;

  for (let i = 0; i < endExclusive; i++) {
    const ch = text[i];
    if (text.startsWith("```", i)) {
      inCodeFence = !inCodeFence;
      i += 2;
      continue;
    }
    if (inCodeFence) continue;
    if (ch === "`") {
      inInlineCode = !inInlineCode;
      continue;
    }
    if (inInlineCode) continue;
    if (ch === "[") {
      squareDepth++;
      continue;
    }
    if (ch === "]") {
      if (squareDepth > 0) squareDepth--;
      continue;
    }
    if (ch === "(" || ch === "（") {
      parenDepth++;
      continue;
    }
    if (ch === ")" || ch === "）") {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (ch === "*") {
      starCount++;
    }
  }

  if (inCodeFence || inInlineCode || squareDepth > 0 || parenDepth > 0) {
    return true;
  }
  // Short unmatched *stage direction* span — wait for closing * unless it's long.
  if (starCount % 2 === 1) {
    const lastStar = text.lastIndexOf("*", endExclusive - 1);
    if (lastStar >= 0 && endExclusive - lastStar < 80) return true;
  }
  // Markdown link: `[label]` immediately followed by `(` without closing `)` yet.
  if (endExclusive < text.length && text[endExclusive - 1] === "]" && text[endExclusive] === "(") {
    return true;
  }
  return false;
}

function isUrlPosition(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 64), index + 1);
  return /(?:https?:\/\/|www\.)\S*$/i.test(before);
}

function isDecimalOrVersionDot(text: string, index: number): boolean {
  const prev = index > 0 ? text[index - 1] : "";
  const next = index + 1 < text.length ? text[index + 1] : "";
  if (/\d/.test(prev) && (/\d/.test(next) || next === "")) return true;
  // e.g. "v2.1" or "Next.js" or "example.com"
  if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) return true;
  return false;
}

/**
 * Accumulates incremental LLM tokens, buffers safely across audio tags,
 * stammers, numbers, and Markdown, and emits complete phrases ready for
 * ElevenLabs Text-to-Dialogue WebSocket streaming.
 */
export class TtsTextBuffer {
  private readonly language: string;
  private readonly maxVisibleChars: number;
  private readonly firstSoftMinChars: number;
  private readonly softMinChars: number;
  private readonly firstMaxSegmentChars: number;
  private readonly maxSegmentChars: number;

  private rawBuffer = "";
  private totalVisibleChars = 0;
  private insideOpenBracket = false;
  private bracketChars = "";
  private stoppedAtCitations = false;
  private segmentIndex = 0;

  constructor(options: TtsTextBufferOptions = {}) {
    this.language = options.language ?? "global";
    this.maxVisibleChars = options.maxVisibleChars ?? replyCharacterLimit;
    this.firstSoftMinChars = options.firstSoftMinChars ?? 14;
    this.softMinChars = options.softMinChars ?? 26;
    this.firstMaxSegmentChars = options.firstMaxSegmentChars ?? 38;
    this.maxSegmentChars = options.maxSegmentChars ?? 90;
  }

  /**
   * Append an incremental LLM token/chunk and return any complete phrases
   * ready to send to ElevenLabs immediately.
   */
  push(token: string): TtsPhraseSegment[] {
    if (!token || this.stoppedAtCitations || this.totalVisibleChars >= this.maxVisibleChars) {
      return [];
    }

    const accepted = this.acceptWithinVisibleBudget(token);
    if (!accepted) return [];

    this.rawBuffer += accepted;

    // Never speak appended citations / source lists.
    const citationMatch = CITATION_MARKER.exec(this.rawBuffer);
    if (citationMatch) {
      this.rawBuffer = this.rawBuffer.slice(0, citationMatch.index);
      this.stoppedAtCitations = true;
      return this.finish();
    }

    return this.drainReadySegments(false);
  }

  /**
   * Flush any remaining buffered text at the end of the LLM response.
   */
  finish(): TtsPhraseSegment[] {
    const segments = this.drainReadySegments(true);
    const remaining = this.rawBuffer.trim();
    this.rawBuffer = "";
    if (!remaining) return segments;

    const clean = speechText(remaining, this.language).trim();
    const tagged = speechTextWithAudioTags(remaining, this.language).trim();
    if (!tagged || (!clean && !hasStandaloneAudioEventTag(tagged))) return segments;

    const index = this.segmentIndex++;
    segments.push({
      taggedText: tagged,
      cleanText: clean,
      index,
      isFirst: index === 0,
      flush: true,
    });
    return segments;
  }

  /** Reset buffer state for a new turn or after provider retry. */
  reset(): void {
    this.rawBuffer = "";
    this.totalVisibleChars = 0;
    this.insideOpenBracket = false;
    this.bracketChars = "";
    this.stoppedAtCitations = false;
    this.segmentIndex = 0;
  }

  private acceptWithinVisibleBudget(token: string): string {
    let out = "";
    for (let i = 0; i < token.length; i++) {
      if (this.totalVisibleChars >= this.maxVisibleChars) break;
      const ch = token[i];
      if (!this.insideOpenBracket && ch === "[") {
        this.insideOpenBracket = true;
        this.bracketChars = "[";
        out += ch;
        continue;
      }
      if (this.insideOpenBracket) {
        this.bracketChars += ch;
        out += ch;
        if (ch === "]") {
          // Completed `[tag]` is audio metadata and consumes 0 visible budget.
          this.insideOpenBracket = false;
          this.bracketChars = "";
        } else if (ch === "\n" || this.bracketChars.length > 122) {
          // Not a valid single-line audio tag; count its chars toward budget.
          this.totalVisibleChars += Math.min(
            this.maxVisibleChars - this.totalVisibleChars,
            this.bracketChars.length,
          );
          this.insideOpenBracket = false;
          this.bracketChars = "";
        }
        continue;
      }
      this.totalVisibleChars += 1;
      out += ch;
    }
    return out;
  }

  private drainReadySegments(atEnd: boolean): TtsPhraseSegment[] {
    const out: TtsPhraseSegment[] = [];

    while (this.rawBuffer.length > 0) {
      const candidate = this.findSplitPoint(atEnd);
      if (!candidate) break;

      const slice = this.rawBuffer.slice(0, candidate.splitAt);
      const rest = this.rawBuffer.slice(candidate.splitAt);

      const clean = speechText(slice, this.language).trim();
      const tagged = speechTextWithAudioTags(slice, this.language).trim();

      // If the slice has no spoken words (e.g., only a leading `[playful]` tag
      // or `(หลบตา)` stage direction), keep it attached to the following words.
      if (!clean || !tagged) {
        if (atEnd) {
          this.rawBuffer = "";
          break;
        }
        // Only drop pure stage-direction-only slices that have no audio tags;
        // otherwise keep buffering so leading `[emotion]` stays with the next sentence.
        break;
      }

      this.rawBuffer = rest.replace(/^[ \t]+/, "");
      const index = this.segmentIndex++;
      const isFirst = index === 0;
      // ElevenLabs TTD holds text until ~40 chars AND 8 whitespace-delimited words
      // unless flush=true is sent. Thai rarely uses spaces, so flush Thai segments
      // and the first phrase promptly to guarantee immediate streaming playback.
      const shouldFlush =
        atEnd ||
        isFirst ||
        candidate.strong ||
        HAS_THAI.test(clean);

      out.push({
        taggedText: tagged,
        cleanText: clean,
        index,
        isFirst,
        flush: shouldFlush,
      });
    }

    return out;
  }

  private findSplitPoint(atEnd: boolean): { splitAt: number; strong: boolean } | null {
    const buf = this.rawBuffer;
    const isFirst = this.segmentIndex === 0;
    const strongMin = isFirst ? 2 : 8;
    const softMin = isFirst ? this.firstSoftMinChars : this.softMinChars;

    let bestSoftSplit: number | null = null;

    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];

      // 1. Strong sentence terminators
      if (ch === "\n") {
        const end = i + 1;
        if (!isInsideUnclosedStructure(buf, end) && this.isSafeSlice(buf.slice(0, end), strongMin, atEnd)) {
          return { splitAt: end, strong: true };
        }
      }

      if (ch === "。" || ch === "！" || ch === "？") {
        let end = i + 1;
        while (end < buf.length && (buf[end] === "」" || buf[end] === "』" || buf[end] === "）" || buf[end] === '"' || buf[end] === "'")) {
          end++;
        }
        if (!isInsideUnclosedStructure(buf, end) && this.isSafeSlice(buf.slice(0, end), strongMin, atEnd)) {
          return { splitAt: end, strong: true };
        }
      }

      if (ch === "!" || ch === "?") {
        if (isUrlPosition(buf, i)) continue;
        // Wait if more consecutive !/? are coming or still mid-token at buffer end
        if (!atEnd && i + 1 >= buf.length) continue;
        if (!atEnd && (buf[i + 1] === "!" || buf[i + 1] === "?")) continue;
        let end = i + 1;
        while (end < buf.length && (buf[end] === '"' || buf[end] === "'" || buf[end] === ")" || buf[end] === "）")) {
          end++;
        }
        if (!atEnd && end < buf.length && /[A-Za-z0-9]/.test(buf[end])) continue;
        if (!isInsideUnclosedStructure(buf, end) && this.isSafeSlice(buf.slice(0, end), strongMin, atEnd)) {
          return { splitAt: end, strong: true };
        }
      }

      if (ch === "." || ch === "…") {
        if (isUrlPosition(buf, i) || isDecimalOrVersionDot(buf, i)) continue;
        if (!atEnd && i + 1 >= buf.length) continue;
        if (!atEnd && ch === "." && buf[i + 1] === ".") continue;
        // Require whitespace/newline after `.` or `…` mid-stream so abbreviations/stammers stay whole
        const next = buf[i + 1] ?? "";
        if (!atEnd && next !== " " && next !== "\n" && next !== "\t" && next !== '"' && next !== "'") {
          continue;
        }
        const end = i + 1;
        const slice = buf.slice(0, end);
        if (TIME_ABBREV_AT.test(slice) && !atEnd) continue;
        if (ch === "…" && TRAILING_STAMMER.test(slice)) continue;
        if (!isInsideUnclosedStructure(buf, end) && this.isSafeSlice(slice, strongMin, atEnd)) {
          return { splitAt: end, strong: true };
        }
      }

      // 2. Soft phrase boundaries (space, comma, semicolon, colon)
      if (ch === " " || ch === "," || ch === "、" || ch === ";" || ch === ":") {
        if (ch === ":" && i + 1 < buf.length && /\d/.test(buf[i + 1])) continue; // HH:MM
        if (isUrlPosition(buf, i)) continue;
        // Do not split right after a standalone space immediately following `[tag]`
        const end = ch === " " ? i : i + 1;
        if (end <= 0) continue;
        if (!atEnd && i + 1 >= buf.length && ch === " ") {
          // Wait for at least 1 char after space only if ending on a number or stammer
          const candidateSlice = buf.slice(0, end);
          if (TRAILING_NUMBER_FRAGMENT.test(candidateSlice) || TRAILING_STAMMER.test(candidateSlice)) {
            continue;
          }
        }
        const candidateSlice = buf.slice(0, end);
        if (TRAILING_NUMBER_FRAGMENT.test(candidateSlice) || TRAILING_STAMMER.test(candidateSlice)) {
          continue;
        }
        if (!isInsideUnclosedStructure(buf, end) && this.isSafeSlice(candidateSlice, softMin, false)) {
          bestSoftSplit = end;
        }
      }
    }

    if (bestSoftSplit !== null) {
      return { splitAt: bestSoftSplit, strong: false };
    }

    // 3. Hard ceiling for long unspaced Thai text (use Intl.Segmenter word boundaries)
    if (!atEnd && !isInsideUnclosedStructure(buf, buf.length)) {
      const maxCeiling = isFirst ? this.firstMaxSegmentChars : this.maxSegmentChars;
      const cleanWhole = speechText(buf, this.language);
      if (cleanWhole.length >= maxCeiling) {
        const wordSplit = this.findThaiWordSplit(buf, softMin, maxCeiling);
        if (wordSplit !== null && wordSplit > 0) {
          return { splitAt: wordSplit, strong: false };
        }
      }
    }

    return null;
  }

  private isSafeSlice(slice: string, minCleanChars: number, atEnd: boolean): boolean {
    if (TRAILING_STAMMER.test(slice)) return false;
    const clean = speechText(slice, this.language).trim();
    if (!clean) return false;
    if (atEnd) return true;
    return clean.length >= minCleanChars;
  }

  private findThaiWordSplit(buf: string, minChars: number, maxCeiling: number): number | null {
    if (!thaiWordSegmenter) return null;
    // Pick a split near ~72% of maxCeiling so both halves sound natural.
    const target = Math.max(minChars, Math.floor(maxCeiling * 0.72));
    let lastValid = 0;
    for (const seg of thaiWordSegmenter.segment(buf)) {
      const end = seg.index + seg.segment.length;
      if (end > buf.length - 4) break;
      // Never split inside an ASCII word, version number, or decimal.
      const prev = buf[end - 1] ?? "";
      const next = buf[end] ?? "";
      if (/[A-Za-z0-9.]/.test(prev) && /[A-Za-z0-9.]/.test(next)) continue;
      if (!isInsideUnclosedStructure(buf, end)) {
        const slice = buf.slice(0, end);
        const clean = speechText(slice, this.language).trim();
        if (clean.length >= minChars && !TRAILING_NUMBER_FRAGMENT.test(slice) && !TRAILING_STAMMER.test(slice)) {
          lastValid = end;
          if (clean.length >= target) return end;
        }
      }
    }
    return lastValid > 0 ? lastValid : null;
  }
}
