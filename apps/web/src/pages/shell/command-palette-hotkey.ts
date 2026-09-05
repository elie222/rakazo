export function isCommandPaletteHotkey(event: KeyboardEvent) {
  if (event.repeat || event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "k";
}
