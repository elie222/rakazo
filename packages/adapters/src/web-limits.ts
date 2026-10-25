export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 10;
export const DEFAULT_WEB_FETCH_MAX_CHARS = 8_000;
export const MAX_WEB_FETCH_MAX_CHARS = 50_000;
export const MIN_WEB_FETCH_MAX_CHARS = 100;

export function clampMaxResults(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_SEARCH_MAX_RESULTS;
  return Math.min(MAX_WEB_SEARCH_RESULTS, Math.max(1, Math.floor(n)));
}

export function clampOffset(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One window of page text; a cut says where the next call should start. */
export function pageWindow(text: string, maxChars: number, offset = 0) {
  const end = offset + maxChars;
  const truncated = text.length > end;
  return {
    text: truncated
      ? `${text.slice(offset, end)}\n\n[Content truncated; continue with offset ${end}]`
      : text.slice(offset),
    truncated,
  };
}

export function clampMaxChars(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_WEB_FETCH_MAX_CHARS;
  return Math.min(MAX_WEB_FETCH_MAX_CHARS, Math.max(MIN_WEB_FETCH_MAX_CHARS, Math.floor(n)));
}
