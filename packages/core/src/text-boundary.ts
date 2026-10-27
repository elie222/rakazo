/** Keep UTF-16 offsets while avoiding cuts inside a surrogate pair. */
export function textBoundary(text: string, offset: number): number {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? offset - 1
    : offset;
}

/** Return a shorter nonempty prefix length, or zero when none exists. */
export function shortenedTextLength(text: string): number {
  const half = textBoundary(text, Math.floor(text.length / 2));
  // When the first character is a surrogate pair, retain it if there is more text.
  return half || (text.length > 2 ? 2 : 0);
}
