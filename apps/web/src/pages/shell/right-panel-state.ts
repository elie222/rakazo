export type Panel =
  | "routines"
  | "pages"
  | "settings"
  | "routine"
  | "create-group"
  | "group-settings"
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
      panel: restoredPanel(value.panel as string | null),
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

/**
 * A bot's panel reopens on the panel itself: a whole list is somewhere it led to, and the
 * computer tab an older version stored is gone.
 */
function restoredPanel(panel: string | null): Panel {
  return panel === "computer" || panel === "routines" || panel === "pages"
    ? "settings"
    : (panel as Panel);
}

export function writeRightPanelState(key: string, panel: Panel, routineId?: string) {
  // Keep the last durable preference while create-group is open.
  if (panel === "create-group") return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ panel, ...(panel === "routine" && routineId ? { routineId } : {}) }),
    );
  } catch {
    // Restricted storage must not prevent opening or closing the panel.
  }
}
