/**
 * Removes a run of `chars` from the end of `text`. Use it rather than `/[…]+$/`, which rescans
 * the run from every position it starts at and grows with the square of its length.
 */
export function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Removes a run of `chars` from the start of `text`. */
export function trimStartChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start]!)) start++;
  return text.slice(start);
}
