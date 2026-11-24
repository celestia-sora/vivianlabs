/**
 * Word segmentation for Kinetic Center Build.
 *
 * Thai does not separate words with spaces, so we rely on `Intl.Segmenter`
 * and fall back to whitespace splitting when it is unavailable. Punctuation is
 * attached to the preceding word so it never animates as a word of its own.
 */

export interface TimedChar {
  char: string;
  start: number;
  end: number;
}

export interface WordTiming {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

const HAS_THAI = /[ก-๙]/u;
const WORD_LIKE = /[\p{L}\p{N}\p{M}]/u;

type SegmenterLike = { segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
const segmenters = new Map<string, SegmenterLike | null>();

function getSegmenter(locale: string): SegmenterLike | null {
  if (segmenters.has(locale)) return segmenters.get(locale) ?? null;
  let seg: SegmenterLike | null = null;
  const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: "word" }) => SegmenterLike }).Segmenter;
  if (typeof Ctor === "function") {
    try { seg = new Ctor(locale, { granularity: "word" }); } catch { seg = null; }
  }
  segmenters.set(locale, seg);
  return seg;
}

/** Removes `[audio tags]` (and stray unbalanced brackets) from plain text. */
export function stripAudioTags(text: string): string {
  return text.replace(/\[[^\]\n]{0,120}\]/gu, " ").replace(/[\[\]]/gu, "").replace(/[ \t]+/gu, " ");
}

interface Span { start: number; end: number }

/** Splits `text` into word spans (UTF-16 offsets) with attached punctuation. */
export function segmentSpans(text: string, language = "th"): Span[] {
  const spans: Span[] = [];
  if (!text) return spans;
  const locale = HAS_THAI.test(text) || language === "th" ? "th" : "en";
  const seg = getSegmenter(locale);
  let pendingStart = -1; // punctuation seen before any word
  const push = (start: number, end: number): void => { spans.push({ start, end }); };

  if (!seg) {
    const re = /\S+/gu;
    for (const m of text.matchAll(re)) push(m.index ?? 0, (m.index ?? 0) + m[0].length);
    return spans;
  }
  for (const part of seg.segment(text)) {
    const start = part.index;
    const end = start + part.segment.length;
    const isWord = part.isWordLike ?? WORD_LIKE.test(part.segment);
    if (isWord) {
      push(pendingStart >= 0 ? pendingStart : start, end);
      pendingStart = -1;
    } else if (/^\s+$/u.test(part.segment)) {
      pendingStart = -1;
    } else if (spans.length > 0 && spans[spans.length - 1].end === start) {
      spans[spans.length - 1].end = end; // trailing punctuation
    } else {
      pendingStart = pendingStart >= 0 ? pendingStart : start; // leading punctuation
    }
  }
  return spans;
}

/** Plain-text word list (no timing). Audio tags are ignored. */
export function segmentText(text: string, language = "th"): string[] {
  const clean = stripAudioTags(text);
  return segmentSpans(clean, language).map((s) => clean.slice(s.start, s.end));
}

/**
 * Builds timed words from ElevenLabs character alignment. Words come from the
 * aligned (original) characters themselves, so no text/alignment re-matching
 * is needed. Bracketed audio tags are dropped.
 */
export function wordsFromTimedChars(chars: readonly TimedChar[], language = "th", idPrefix = "w", firstIndex = 0): WordTiming[] {
  // Remove audio tags while keeping a UTF-16 unit → char index map.
  let text = "";
  const unitToChar: number[] = [];
  let depth = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i].char;
    if (ch === "[") { depth += 1; continue; }
    if (ch === "]") { if (depth > 0) depth -= 1; continue; }
    if (depth > 0) continue;
    for (let u = 0; u < ch.length; u += 1) { text += ch[u]; unitToChar.push(i); }
  }
  const words: WordTiming[] = [];
  for (const span of segmentSpans(text, language)) {
    const first = chars[unitToChar[span.start]];
    const last = chars[unitToChar[span.end - 1]];
    if (!first || !last) continue;
    words.push({
      id: `${idPrefix}${firstIndex + words.length}`,
      text: text.slice(span.start, span.end),
      startSec: first.start,
      endSec: Math.max(first.start, last.end),
    });
  }
  return words;
}
