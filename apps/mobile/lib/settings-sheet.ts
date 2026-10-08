// On iOS a screen opened on the root stack while the settings sheet is open is presented as a
// second sheet over it, so navigation that leaves settings closes the sheet first.
let closeSheet: (() => void) | null = null;

// The pages in app/(settings). A link to one of them opens inside the sheet.
const settingsScreens = new Set([
  "account",
  "ai-data-sharing",
  "archived-bots",
  "change-password",
  "integration-setup",
  "integrations",
  "models",
  "voice",
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

/** Closes the settings sheet if one is open. */
export function closeSettingsSheet() {
  closeSheet?.();
}

/** Whether a link (`rakazo:///models`, `rakazo://models` or `/models`) opens a settings page. */
export function isSettingsLink(link: string): boolean {
  const screen = link
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
    .replace(/^\/+/, "")
    .split(/[/?#]/, 1)[0];
  return settingsScreens.has(screen ?? "");
}
