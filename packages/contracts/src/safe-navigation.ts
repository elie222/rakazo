/** Fixed origin for validating path-only deep links without a browser origin. */
export const INTERNAL_PATH_RESOLVE_ORIGIN = "https://rakazo.app";

/** Accept only same-origin in-app paths for post-auth redirects. */
export function safeInternalAppPath(next: string, origin: string): string | null {
  if (!next || next.includes("\\") || next.includes("\0")) return null;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/")) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
