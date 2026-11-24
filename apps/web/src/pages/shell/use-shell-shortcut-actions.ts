import type { Bot, BotSection, Group } from "@rakazo/contracts";
import { chatSnoozed, groupBotsForSidebar } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { hasOpenDialog } from "../../lib/platform/has-open-dialog";
import type { Panel } from "./right-panel-state";
import type { ShellOverlay } from "./shell-overlay-url";
import { cycleBotId, findPanelAction, useShellShortcuts } from "./shell-shortcuts";
import { focusSidebarSearch } from "./sidebar/shell-sidebar";

/**
 * What each shell shortcut does, and the state the shortcuts open: the shortcut list, the chat's
 * find bar, the side panel for the open chat, and the composer's focus.
 */
export function useShellShortcutActions({
  botId,
  groupId,
  active,
  activeGroup,
  bots,
  botSections,
  snoozeNow,
  navigate,
  selectBot,
  setCommandPaletteOpen,
  setCreateMenuOpen,
  setOverlay,
  panel,
  setPanel,
  panelOverlays,
  computerOpen,
  isMobileSidebar,
  mobileSidebarOpen,
  setMobileSidebarOpen,
  sidebarCollapsed,
  setSidebarCollapsed,
  openSidebarSearch,
  modelShortcuts,
  refreshThread,
}: {
  /** The chat the route names. */
  botId: string | undefined;
  groupId: string | undefined;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  bots: Bot[];
  botSections: BotSection[];
  snoozeNow: number;
  navigate: NavigateFunction;
  selectBot: (id: string) => void;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setCreateMenuOpen: (open: boolean) => void;
  setOverlay: (overlay: ShellOverlay) => void;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  panelOverlays: boolean;
  computerOpen: boolean;
  isMobileSidebar: boolean;
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  openSidebarSearch: () => void;
  modelShortcuts: {
    open: boolean;
    run: (shortcut: "model-picker" | "thinking-level") => boolean;
  };
  refreshThread: (botId: string) => Promise<unknown>;
}) {
  const inGroup = Boolean(groupId);
  const chatPanelOpen = inGroup
    ? panel === "group-settings"
    : panel === "routines" || panel === "pages" || panel === "settings" || panel === "routine";
  const cycleBots = useMemo(
    () =>
      groupBotsForSidebar(
        bots.filter((bot) => !chatSnoozed(bot, snoozeNow)),
        botSections,
      ).flatMap((group) => group.bots),
    [bots, botSections, snoozeNow],
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Matches belong to the chat they were found in.
  useEffect(() => setFindOpen(false), [botId, groupId]);
  const quoteShortcutRef = useRef<(() => boolean) | null>(null);
  const registerQuoteShortcut = useCallback((handler: (() => boolean) | null) => {
    quoteShortcutRef.current = handler;
  }, []);
  const focusComposer = useCallback(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      'textarea[name="chat-message"]:not(:disabled)',
    );
    composer?.focus();
    return Boolean(composer);
  }, []);
  function toggleChatPanel() {
    if (chatPanelOpen) setPanel(null);
    else if (inGroup) setPanel("group-settings");
    else if (active) {
      setPanel("settings");
      // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
      void bestEffort("refresh thread for chat panel", refreshThread(active.id));
    } else return false;
    return true;
  }
  useShellShortcuts({
    run: (shortcut) => {
      switch (shortcut.type) {
        case "command-menu":
          setCommandPaletteOpen((open) => !open);
          return true;
        case "new":
          setCreateMenuOpen(true);
          return true;
        case "shortcuts":
          setShortcutsOpen((open) => !open);
          return true;
        case "back":
        case "forward":
          void navigate(shortcut.type === "back" ? -1 : 1);
          return true;
      }
      // The full-screen computer covers the sidebar and takes the keyboard.
      if (computerOpen) return false;
      if (shortcut.type === "toggle-sidebar") {
        if (isMobileSidebar) setMobileSidebarOpen((open) => !open);
        else setSidebarCollapsed(!sidebarCollapsed);
        return true;
      }
      if (shortcut.type === "search") {
        if (isMobileSidebar) setMobileSidebarOpen(true);
        else if (sidebarCollapsed) setSidebarCollapsed(false);
        openSidebarSearch();
        focusSidebarSearch();
        return true;
      }
      // The open model list is a dialog too, but its own chords still close it or step its thinking.
      if (
        (shortcut.type === "model-picker" || shortcut.type === "thinking-level") &&
        modelShortcuts.open
      ) {
        return modelShortcuts.run(shortcut.type);
      }
      // The command menu picks its own Cmd/Ctrl+1–9 from what it lists.
      if (hasOpenDialog(document, true)) return false;
      switch (shortcut.type) {
        case "new-group":
          // A space without bots has nobody to add, and the side panel needs a chat to open in.
          if (!active && !activeGroup) return false;
          setPanel("create-group");
          return true;
        case "integrations":
          setOverlay({ kind: "integrations" });
          return true;
        case "chat-panel":
          // A form in the side panel (a new group, an import) keeps its unsaved input.
          if (panel && !chatPanelOpen) return false;
          return toggleChatPanel();
        case "focus-composer":
          return focusComposer();
        case "model-picker":
        case "thinking-level":
          return modelShortcuts.run(shortcut.type);
        case "quote-selection":
          if (mobileSidebarOpen || (isMobileSidebar && panel)) return false;
          return quoteShortcutRef.current?.() ?? false;
        case "find":
          if (!active && !activeGroup) return false;
          // The drawer makes the chat inert and a side panel can cover it, so either would hide
          // the bar. A panel holding a form keeps its input instead.
          {
            const action = findPanelAction(
              isMobileSidebar || panelOverlays,
              !!panel,
              chatPanelOpen,
            );
            if (action === "refuse") return false;
            if (action === "close-panel") setPanel(null);
          }
          setMobileSidebarOpen(false);
          setFindOpen(true);
          // A bar already open may have lost focus; a new one focuses itself as it mounts.
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
          return true;
      }
      const nextBotId =
        shortcut.type === "bot"
          ? cycleBots[shortcut.index]?.id
          : cycleBotId(cycleBots, active?.id, shortcut.type === "next-bot" ? 1 : -1);
      if (!nextBotId) return false;
      selectBot(nextBotId);
      return true;
    },
    onTyping: () => {
      if (computerOpen || hasOpenDialog(document, true)) return;
      focusComposer();
    },
  });
  return {
    chatPanelOpen,
    toggleChatPanel,
    focusComposer,
    registerQuoteShortcut,
    shortcutsOpen,
    setShortcutsOpen,
    findOpen,
    setFindOpen,
    findInputRef,
  };
}
