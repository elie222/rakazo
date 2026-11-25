import type { Href } from "expo-router";

// On iOS a screen opened on the root stack while the settings sheet is open is presented as a
// second sheet over it, so navigation that leaves settings closes the sheet first.
let closeSheet: (() => void) | null = null;

// The pages in app/(settings). A link to one of them opens inside the sheet.
const settingsScreens = new Set([
  "billing",
  "account",
  "ai-data-sharing",
  "approval-rule-add",
  "approvals",
  "archived-bots",
  "bot-template",
  "bot-templates",
  "change-password",
  "computers",
  "general",
  "integration-setup",
  "integrations",
  "labs",
  "messaging",
  "language",
  "mcp-server",
  "memory",
  "memory-note",
  "model-settings",
  "models",
  "organization",
  "organization-members",
  "plugin",
  "profile",
  "signup-survey",
  "skill",
  "skills",
  "space",
  "spaces",
  "spending-limit",
  "team-conversation",
  "vault",
  "voice",
  "wallet",
]);

/** Registers the open settings sheet's close action; the returned function unregisters it. */
export function registerSettingsSheet(close: () => void): () => void {
  closeSheet = close;
  return () => {
    if (closeSheet === close) closeSheet = null;
  };
}

type SheetNavigation = {
  canGoBack(): boolean;
  goBack(): void;
  dispatch(action: { type: "REPLACE"; payload: { name: string } }): void;
};

/** The sheet's close action: back to the screen it opened over. As the app's first screen (a cold
 * deep link or first-run setup) there is nothing under it, so it gives way to Home and the screen
 * opened next still lands on the root stack. */
export function settingsSheetCloser(sheet: SheetNavigation): () => void {
  return () => {
    if (sheet.canGoBack()) sheet.goBack();
    else sheet.dispatch({ type: "REPLACE", payload: { name: "index" } });
  };
}

export function closeSettingsSheet() {
  closeSheet?.();
}

/** Opens a root route after dismissing settings, matching navigation from archived chats. */
export function openFromSettingsSheet(router: { push(href: Href): void }, href: Href): void {
  closeSettingsSheet();
  router.push(href);
}

/** The screen a link (`rakazo:///models`, `rakazo://models` or `/models`) opens. */
export function linkScreen(link: string): string {
  return (
    link
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .replace(/^\/+/, "")
      .split(/[/?#]/, 1)[0] ?? ""
  );
}

/** Whether a link opens a settings page. */
export function isSettingsLink(link: string): boolean {
  return settingsScreens.has(linkScreen(link));
}

/** The Settings return marker belongs to navigation inside this app. */
export function stripSettingsReturn(path: string): string {
  const queryStart = path.indexOf("?");
  const hashStart = path.indexOf("#");
  if (queryStart < 0 || (hashStart >= 0 && hashStart < queryStart)) return path;

  const query = new URLSearchParams(
    path.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart),
  );
  if (!query.has("fromSettings")) return path;
  query.delete("fromSettings");

  const search = query.toString();
  const hash = hashStart < 0 ? "" : path.slice(hashStart);
  return `${path.slice(0, queryStart)}${search ? `?${search}` : ""}${hash}`;
}
