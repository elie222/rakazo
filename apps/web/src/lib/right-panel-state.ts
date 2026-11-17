export type Panel =
  | "computer"
  | "routines"
  | "pages"
  | "settings"
  | "routine"
  | "create-group"
  | "group-settings"
  | "import-agent"
  | null;
export type RightPanelState = { panel: Panel; routineId?: string };

/** Panels that are safe to remember across reloads. */
const durablePanels: readonly (string | null)[] = [
  "computer",
  "routines",
  "pages",
  "settings",
  "routine",
  "group-settings",
  null,
];

export function rightPanelStorageKey(
  userId: string,
  spaceId: string,
  kind: "bot" | "group",
  targetId: string,
): string {
  return `rakazo:right-panel-state:${userId}:${spaceId}:${kind}:${targetId}`;
}

export function readRightPanelState(key: string): RightPanelState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("panel" in value) ||
      !durablePanels.includes(value.panel as string | null)
    )
      return { panel: null };
    return {
      panel: value.panel as Panel,
      ...(value.panel === "routine" &&
      "routineId" in value &&
      typeof value.routineId === "string" &&
      value.routineId
        ? { routineId: value.routineId }
        : {}),
    };
  } catch {
    return { panel: null };
  }
}

export type BotTab = "computer" | "routines" | "pages" | "settings";

function isBotTab(value: unknown): value is BotTab {
  return value === "computer" || value === "routines" || value === "pages" || value === "settings";
}

function storedBotTab(key: string): BotTab | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object" && "tab" in value && isBotTab(value.tab))
      return value.tab;
  } catch {
    // Unreadable storage means there is no remembered tab.
  }
  return undefined;
}

/**
 * The tab a bot's panel opens on when it is toggled open: the last tab it showed, kept even
 * while the panel is closed and across reloads, else Computer.
 */
export function readLastBotTab(key: string | null): BotTab {
  return (key && storedBotTab(key)) || "computer";
}

/** A bot's panel reopens on the tab it was left on, so someone watching the computer finds it again. */
export function writeRightPanelState(key: string, panel: Panel, routineId?: string) {
  // Keep the last durable preference while create-group or an import is open.
  if (panel === "create-group" || panel === "import-agent") return;
  try {
    const tab = isBotTab(panel) ? panel : storedBotTab(key);
    localStorage.setItem(
      key,
      JSON.stringify({
        panel,
        ...(tab ? { tab } : {}),
        ...(panel === "routine" && routineId ? { routineId } : {}),
      }),
    );
  } catch {
    // Restricted storage must not prevent opening or closing the panel.
  }
}
