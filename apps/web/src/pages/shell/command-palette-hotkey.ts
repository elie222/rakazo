function isCommandChord(event: KeyboardEvent, key: string) {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === key;
}

export function isCommandPaletteHotkey(event: KeyboardEvent) {
  return isCommandChord(event, "k");
}

/** Browsers reserve Cmd/Ctrl-N for a new window, so this only reaches the desktop app. */
export function isCreateMenuHotkey(event: KeyboardEvent) {
  return isCommandChord(event, "n");
}

/**
 * Ctrl-Tab in the desktop app; Cmd/Ctrl-Shift-ArrowDown in a browser, which owns Ctrl-Tab.
 * Arrow keys rather than brackets: Safari claims Cmd-Shift-] and Cmd-Shift-[ for its own tabs.
 */
export function isSwitchBotHotkey(event: KeyboardEvent) {
  if (event.repeat || event.altKey) return false;
  if (!event.metaKey && event.ctrlKey && !event.shiftKey && event.key === "Tab") return true;
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "ArrowDown";
}

/** Ctrl-Shift-Tab in the desktop app; Cmd/Ctrl-Shift-ArrowUp in a browser. */
export function isSwitchBotBackHotkey(event: KeyboardEvent) {
  if (event.repeat || event.altKey) return false;
  if (!event.metaKey && event.ctrlKey && event.shiftKey && event.key === "Tab") return true;
  return (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "ArrowUp";
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
