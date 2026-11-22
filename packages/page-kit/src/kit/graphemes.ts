const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/** Whole user-perceived characters, so a flag or ZWJ emoji is never split. Code points without Intl.Segmenter. */
export const graphemes = (text: string): string[] =>
  segmenter ? Array.from(segmenter.segment(text), ({ segment }) => segment) : Array.from(text);
