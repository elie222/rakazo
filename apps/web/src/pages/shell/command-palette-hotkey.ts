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
