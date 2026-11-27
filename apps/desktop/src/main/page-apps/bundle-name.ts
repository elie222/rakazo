const MAX_NAME_LENGTH = 60;
const FALLBACK_NAME = "Page";

/**
 * A page title as an app's file and process name: no path separators, no leading dots that
 * would hide it, no control characters, and short enough for the menu bar.
 */
export function pageAppName(title: string): string {
  const name = [
    ...title
      .replace(/\s+/g, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/[/:\\]/g, "-")
      .trim()
      .replace(/^[.\s]+/, ""),
  ]
    .slice(0, MAX_NAME_LENGTH)
    .join("")
    .trim();
  return name || FALLBACK_NAME;
}

/** The bundle file name for an app, numbered when another app already has the name. */
export function uniqueBundleName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((entry) => entry.toLowerCase()));
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? `${name}.app` : `${name} ${number}.app`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** Ids reach file paths and bundle identifiers, so only plain characters pass. */
export const PAGE_APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function pageAppBundleId(appId: string): string {
  return `dev.rakazo.page-app.${appId.toLowerCase().replace(/_/g, "-")}`;
}
