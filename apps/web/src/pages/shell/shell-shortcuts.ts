import type { DesktopMenuCommand } from "@rakazo/contracts";
import { isDesktopMenuCommand } from "@rakazo/contracts";
import { useEffect, useEffectEvent } from "react";
import { desktopBridge } from "../../lib/platform/desktop";
import { useEventListener } from "../../lib/use-event-listener";

export type ShellShortcut =
  | { type: DesktopMenuCommand }
  | { type: "focus-composer" }
  | { type: "quote-selection" }
  | { type: "model-picker" }
  | { type: "thinking-level" }
  | { type: "bot"; index: number };

/**
 * Browsers keep Cmd+F (their own find already covers the chat), Cmd+1–9 and their history chords, so those only reach the desktop app.
 * Apple keyboards use Cmd alone for the newer chords, since Ctrl+B and Ctrl+F move the caret there.
 */
export type ShortcutHost = { desktop: boolean; apple: boolean };

export function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  // platform is deprecated but still the most reliable Apple check in browsers.
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** Cmd on Apple keyboards and Ctrl elsewhere, held without the other. */
export function primaryModifier(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, apple: boolean) {
  return apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Browsers keep the plain chord for their address bar, so on the web the page answers Shift instead.
 * The desktop app has no address bar, so it answers the plain chord. Neither consumes the key on its
 * own: the shell only takes it while a transcript selection is armed.
 */
function quoteChord(host: ShortcutHost) {
  return { key: "L", shift: !host.desktop };
}

/** A Cmd/Ctrl chord's keys as the platform writes them. */
export function chordKeys(host: Pick<ShortcutHost, "apple">, key: string, shift = false) {
  return [host.apple ? "⌘" : "Ctrl", ...(shift ? [host.apple ? "⇧" : "Shift"] : []), key];
}

/** A chord's keys as one label, the way Apple writes them run together and others join with +. */
export function chordLabel(host: Pick<ShortcutHost, "apple">, keys: readonly string[]) {
  return keys.join(host.apple ? "" : "+");
}

export function quoteShortcutKeys(host: ShortcutHost) {
  const chord = quoteChord(host);
  return chordKeys(host, chord.key, chord.shift);
}

export function isQuoteShortcut(event: KeyboardEvent, host: ShortcutHost) {
  if (!primaryModifier(event, host.apple) || event.altKey || event.repeat) return false;
  const chord = quoteChord(host);
  return event.key.toUpperCase() === chord.key && event.shiftKey === chord.shift;
}

/** The chord `isQuoteShortcut` answers, written the way the pill shows it. */
export function quoteShortcutLabel(host: ShortcutHost) {
  return chordLabel(host, quoteShortcutKeys(host));
}

export function isComposingKey(event: KeyboardEvent) {
  // The legacy IME key code also covers composition-boundary keydowns.
  return event.isComposing || event.keyCode === 229;
}

/**
 * The shell shortcut a key press asks for. Next and previous bot are Ctrl-Tab in the desktop app and
 * Cmd/Ctrl-Shift-ArrowDown/Up in a browser, which owns Ctrl-Tab; arrows rather than brackets because
 * Safari claims Cmd-Shift-] and Cmd-Shift-[ for its own tabs, and not while typing, where they select.
 */
export function shellShortcut(event: KeyboardEvent, host: ShortcutHost): ShellShortcut | null {
  if (event.repeat || !event.key || isComposingKey(event)) return null;
  const key = event.key.toLowerCase();
  if (key === "l" && isQuoteShortcut(event, host)) {
    return { type: "quote-selection" };
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    if (key === "k") return { type: "command-menu" };
    if (key === "n") return { type: "new" };
  }
  const primary = primaryModifier(event, host.apple);
  // Some layouts need Shift for the slash, so Shift does not matter here.
  if (primary && !event.altKey && event.key === "/") return { type: "shortcuts" };
  if (primary && !event.altKey && !event.shiftKey) {
    if (key === "b") return { type: "toggle-sidebar" };
    if (key === "i") return { type: "focus-composer" };
    if (host.desktop && key === "f") return { type: "find" };
    if (host.desktop && /^[1-9]$/.test(key)) return { type: "bot", index: Number(key) - 1 };
    if (host.desktop && host.apple && (key === "[" || key === "]")) {
      return { type: key === "[" ? "back" : "forward" };
    }
  }
  if (primary && event.shiftKey && !event.altKey) {
    // Browsers open a private window on this chord before the page sees it.
    if (host.desktop && key === "n") return { type: "new-group" };
    if (host.desktop && key === "f") return { type: "search" };
    // Chrome opens its tab search on this chord before the page sees it.
    if (host.desktop && key === "a") return { type: "integrations" };
    if (key === "m") return { type: "model-picker" };
    if (key === "e") return { type: "thinking-level" };
    // The code, because Shift turns the comma into another character on most layouts.
    if (event.code === "Comma") return { type: "chat-panel" };
  }
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
    return { type: event.shiftKey ? "previous-bot" : "next-bot" };
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    !isEditableTarget(event.target)
  ) {
    return { type: event.key === "ArrowDown" ? "next-bot" : "previous-bot" };
  }
  if (
    host.desktop &&
    !host.apple &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    return { type: event.key === "ArrowLeft" ? "back" : "forward" };
  }
  return null;
}

/**
 * What Find does about the side panel. A panel that floats over the chat would hide the bar, so a
 * details panel closes first; a panel holding a form keeps its unsaved input and Find waits.
 */
export function findPanelAction(
  overlaysChat: boolean,
  panelOpen: boolean,
  chatPanelOpen: boolean,
): "open" | "close-panel" | "refuse" {
  if (!overlaysChat || !panelOpen) return "open";
  return chatPanelOpen ? "close-panel" : "refuse";
}

/** A printable key pressed outside any text field, which belongs in the composer. */
export function startsTyping(event: KeyboardEvent) {
  return (
    event.key?.length === 1 &&
    event.key !== " " &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isComposingKey(event) &&
    !isEditableTarget(event.target)
  );
}

/** The next id in roster order, wrapping at both ends. */
export function cycleBotId(
  bots: readonly { id: string }[],
  activeId: string | undefined,
  step: 1 | -1,
) {
  if (bots.length === 0) return undefined;
  const index = activeId === undefined ? -1 : bots.findIndex((bot) => bot.id === activeId);
  const next =
    index === -1 ? (step === 1 ? 0 : bots.length - 1) : (index + step + bots.length) % bots.length;
  return bots[next]?.id;
}

/**
 * Every shell-wide shortcut, from the keyboard and from the desktop app's menu. The page handles the
 * chords itself because the desktop app can show a server's own page, older or newer than its menu.
 * `run` answers whether the shortcut applied, so one that does not keeps the key's default.
 */
export function useShellShortcuts({
  run,
  onTyping,
}: {
  run: (shortcut: ShellShortcut) => boolean;
  onTyping: () => void;
}) {
  const runLatest = useEffectEvent(run);
  useEventListener(window, "keydown", (event) => {
    if (event.defaultPrevented) return;
    const host: ShortcutHost = { desktop: Boolean(desktopBridge()), apple: isApplePlatform() };
    const shortcut = shellShortcut(event, host);
    if (shortcut) {
      if (run(shortcut)) event.preventDefault();
    } else if (startsTyping(event)) {
      onTyping();
    }
  });
  useEffect(
    () =>
      desktopBridge()?.menu?.onCommand((command) => {
        if (isDesktopMenuCommand(command)) runLatest({ type: command });
      }),
    [],
  );
}
