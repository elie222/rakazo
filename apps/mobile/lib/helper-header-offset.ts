/** Keep a toggled helper's header at the same window position in the inverted list. */
export function helperHeaderOffset(offset: number, before: number, after: number): number {
  return Math.max(0, offset + before - after);
}

/** Reveal the opened card while giving its header priority over its bottom edge. */
export function helperOpenTarget({
  headerY,
  cardBottom,
  topLimit,
  visibleBottom,
}: {
  headerY: number;
  cardBottom: number;
  topLimit: number;
  visibleBottom: number;
}): number {
  return Math.max(topLimit, headerY - Math.max(0, cardBottom - visibleBottom));
}
