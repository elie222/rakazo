/** Scripts written without spaces between words, so whitespace cannot count them. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Keep Latin words, digits, and their combining accents together in mixed-script text. */
const FALLBACK_WORDS = /[\p{Script=Latin}\p{Nd}][\p{Script=Latin}\p{Nd}\p{M}]*|./gu;

let segmenter: { ctor: unknown; instance: Intl.Segmenter } | null = null;

/** Hermes (mobile) and older engines may not ship `Intl.Segmenter`. */
function wordSegmenter(): Intl.Segmenter | null {
  const ctor = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!ctor) return null;
  if (segmenter?.ctor !== ctor) {
    segmenter = { ctor, instance: new ctor(undefined, { granularity: "word" }) };
  }
  return segmenter.instance;
}

/** Without a segmenter, each character of an unspaced script stands in for a word. */
function tokens(text: string): { words: string[]; fallback: boolean } {
  const segment = wordSegmenter();
  const words: string[] = [];
  let fallback = false;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (!UNSPACED.test(token)) {
      words.push(token);
    } else if (segment) {
      for (const part of segment.segment(token)) {
        if (part.isWordLike) words.push(part.segment);
      }
    } else {
      fallback = true;
      words.push(...(token.match(FALLBACK_WORDS) ?? []));
    }
  }
  return { words, fallback };
}

/** Words of a transcript, splitting Chinese, Japanese, Thai and the like that have no spaces. */
export function speechWords(text: string): string[] {
  return tokens(text).words;
}

/**
 * How many words a transcript holds. With no segmenter a character of an unspaced
 * script is far less than a word, so two of them count as one.
 */
export function speechWordCount(text: string): number {
  const { words, fallback } = tokens(text);
  if (!fallback) return words.length;
  const spaced = words.filter((word) => !UNSPACED.test(word)).length;
  return spaced + Math.ceil((words.length - spaced) / 2);
}
