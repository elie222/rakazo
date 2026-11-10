export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 10;
export const DEFAULT_WEB_FETCH_MAX_CHARS = 8_000;
export const MAX_WEB_FETCH_MAX_CHARS = 50_000;
export const MIN_WEB_FETCH_MAX_CHARS = 100;
/** Highest offset web_fetch accepts. A keyless page fits in this many characters. */
export const MAX_WEB_FETCH_OFFSET = 5 * 1024 * 1024;

export function clampMaxResults(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_SEARCH_MAX_RESULTS;
  return Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Math.floor(n)));
}

export function clampOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const offset = Math.floor(n);
  if (offset > MAX_WEB_FETCH_OFFSET) {
    throw new Error(`web_fetch can skip at most ${MAX_WEB_FETCH_OFFSET} characters.`);
  }
  return offset;
}

/**
 * Text that already starts at `offset`. A cut names the next offset when that
 * read is still allowed, and says the read limit was reached when it is not.
 */
export function pageWindow(
  rest: string,
  maxChars: number,
  offset = 0,
  maxOffset = MAX_WEB_FETCH_OFFSET,
) {
  if (rest.length <= maxChars) return { text: rest, truncated: false };
  const next = offset + maxChars;
  const note =
    maxChars > 0 && next <= maxOffset
      ? `continue with offset ${next}`
      : "stopped at the read limit";
  return {
    text: `${rest.slice(0, maxChars)}\n\n[Content truncated; ${note}]`,
    truncated: true,
  };
}

export function clampMaxChars(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_FETCH_MAX_CHARS;
  return Math.min(MAX_WEB_FETCH_MAX_CHARS, Math.max(MIN_WEB_FETCH_MAX_CHARS, Math.floor(n)));
}
