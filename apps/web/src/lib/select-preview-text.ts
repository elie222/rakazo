import type { RefObject } from "react";
import { useEventListener } from "./use-event-listener";

/** Controls that keep their own select-all, even inside a preview. */
const OWN_SELECT_ALL = "input, textarea, select, [contenteditable]";

/**
 * Selects the previewed file for Cmd/Ctrl+A instead of the page behind it. A file preview sits
 * over a chat still holding its transcript, so the browser's own select-all swept in earlier
 * messages; the preview that holds focus (or the selection) now answers with just its file.
 */
export function useSelectPreviewText(
  region: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEventListener(document, "keydown", (event) => {
    if (!enabled || event.key.toLowerCase() !== "a") return;
    // The desktop app's menu shortcut and other modified forms keep their own meaning.
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : null;
    const root = region.current;
    if (!target || !root || target.closest(OWN_SELECT_ALL)) return;
    const selection = window.getSelection();
    // The dialog a preview opens in counts as holding it, since its header buttons take focus
    // before the file's text does.
    const dialog = target.closest(
      "[data-slot='dialog-content'], [role='dialog'], [role='alertdialog']",
    );
    const anchor = selection?.anchorNode ?? null;
    const withinPreview =
      root.contains(target) ||
      (document.activeElement instanceof Node && root.contains(document.activeElement)) ||
      (anchor !== null && root.contains(anchor)) ||
      dialog?.contains(root) === true;
    if (!withinPreview) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    event.preventDefault();
  });
}
