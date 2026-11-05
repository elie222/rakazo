import { createContext, useContext } from "react";

/**
 * The one place that decides the desktop columns: bots sidebar, thread, bot panel.
 *
 * Inputs are the window width and what the user asked for (dragged widths, the rail, an open
 * panel). The thread always keeps at least CHAT_MIN_WIDTH. When room runs out the bot panel
 * folds first, then the sidebar narrows down to SIDEBAR_MIN_WIDTH, then it becomes the rail.
 */
export const CHAT_MIN_WIDTH = 400;
export const RAIL_WIDTH = 80;
export const SIDEBAR_MIN_WIDTH = 200;
export const PANEL_MIN_WIDTH = 220;
/** A drag released below this snaps the sidebar to the rail, or closes the panel. */
export const DRAG_COLLAPSE_WIDTH = 150;

export type ColumnRequest = {
  viewportWidth: number;
  /** The width the user gave the sidebar, ignored while it is a rail. */
  sidebarWidth: number;
  sidebarRail: boolean;
  panelOpen: boolean;
  /** The width the user gave the panel. */
  panelWidth: number;
  /**
   * The user asked for the panel while there was no room for it: the sidebar steps down to
   * the rail to make room, rather than the panel covering the thread.
   */
  panelPriority?: boolean;
};

export type Columns = {
  sidebarWidth: number;
  /** The sidebar shows as the rail, by choice or because the window is too narrow. */
  rail: boolean;
  /** The window, not the user, put the sidebar on the rail. */
  autoRail: boolean;
  /** 0 when the panel is closed or folded away. */
  panelWidth: number;
  /** The panel is open but there is no room for it beside the thread. */
  panelFolded: boolean;
};

export function columnsFor({
  viewportWidth,
  sidebarWidth,
  sidebarRail,
  panelOpen,
  panelWidth,
  panelPriority = false,
}: ColumnRequest): Columns {
  let wantedSidebar = sidebarRail ? RAIL_WIDTH : sidebarWidth;
  let panel = 0;
  if (panelOpen) {
    const room = viewportWidth - wantedSidebar - CHAT_MIN_WIDTH;
    panel = room >= PANEL_MIN_WIDTH ? Math.min(panelWidth, room) : 0;
    const roomBesideRail = viewportWidth - RAIL_WIDTH - CHAT_MIN_WIDTH;
    if (panel === 0 && panelPriority && roomBesideRail >= PANEL_MIN_WIDTH) {
      wantedSidebar = RAIL_WIDTH;
      panel = Math.min(panelWidth, roomBesideRail);
    }
  }
  let sidebar = wantedSidebar;
  let autoRail = false;
  if (!sidebarRail) {
    const room = viewportWidth - panel - CHAT_MIN_WIDTH;
    if (room >= SIDEBAR_MIN_WIDTH) sidebar = Math.min(wantedSidebar, room);
    else {
      sidebar = RAIL_WIDTH;
      autoRail = true;
    }
  }
  return {
    sidebarWidth: Math.round(sidebar),
    rail: sidebarRail || autoRail,
    autoRail,
    panelWidth: Math.round(panel),
    panelFolded: panelOpen && panel === 0,
  };
}

export type ColumnLayout = Columns & {
  /** The panel reports whether it is open and the width the user gave it. */
  setPanelRequest: (request: { open: boolean; width: number; priority: boolean }) => void;
};

export const ColumnLayoutContext = createContext<ColumnLayout | null>(null);

export function useColumnLayout() {
  return useContext(ColumnLayoutContext);
}
