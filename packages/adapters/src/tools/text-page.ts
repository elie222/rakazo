/**
 * Ceiling for the whole serialized result of a paged read. The page competes with the result's
 * other fields and JSON escaping for the same budget, so the page shrinks until the result fits,
 * with headroom under the generic tool-result cut.
 */
export const SERIALIZED_PAGE_LIMIT = 10_000;
/** Largest page of a long text one read returns; the rest come on request by offset. */
const TEXT_PAGE_SIZE = 8_000;

/** A page must not end inside a UTF-16 surrogate pair. */
export const endsWholeCharacter = (text: string, end: number) => {
  const last = text.charCodeAt(end - 1);
  return last < 0xd800 || last > 0xdbff;
};

export type TextPaging = { length: number; nextOffset: number | null };

/**
 * The largest page of `text` from `offset` whose result, as `build` shapes it, fits the limit.
 * Undefined when the result's other fields leave no room for any text: a page that does not
 * advance would send the model back to the same offset forever.
 */
export function fitTextPage<T>(
  text: string,
  offset: number,
  build: (page: string, paging: TextPaging) => T,
): T | undefined {
  const total = text.length;
  const paged = (end: number) =>
    build(text.slice(offset, end), { length: total, nextOffset: end < total ? end : null });
  const fits = (end: number) => JSON.stringify(paged(end)).length <= SERIALIZED_PAGE_LIMIT;
  // Serialized length only grows as the page grows, so the largest fitting end is a search.
  let low = offset + 1;
  let high = Math.min(offset + TEXT_PAGE_SIZE, total);
  let end = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      end = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (end < total && !endsWholeCharacter(text, end)) end -= 1;
  return end > offset && fits(end) ? paged(end) : undefined;
}
