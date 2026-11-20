/**
 * Links that open a note in an app on the reader's device. These open without the prompt web
 * links show, so each entry allows one action that only opens content, with its parameters: an
 * action that writes files, runs a command or reaches a plugin never belongs here. Web, desktop
 * and mobile share the list so a link opens the same way everywhere.
 */
const APP_LINKS = new Map([["obsidian:", { action: "open", params: new Set(["vault", "file"]) }]]);

/** The link to open when a URL is a listed app link, otherwise undefined. */
export function appLinkUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const app = APP_LINKS.get(parsed.protocol);
  if (!app || parsed.host !== app.action || parsed.username || parsed.password) return undefined;
  if (parsed.pathname || parsed.hash) return undefined;
  for (const key of parsed.searchParams.keys()) if (!app.params.has(key)) return undefined;
  return parsed.href;
}
