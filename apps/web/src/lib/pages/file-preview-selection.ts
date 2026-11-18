import type { KeyboardEvent } from "react";

/** Keep file selection inside its preview, leaving native editing shortcuts alone. */
export function selectFilePreviewContents(
  event: Pick<
    KeyboardEvent<HTMLElement>,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "altKey"
    | "shiftKey"
    | "target"
    | "currentTarget"
    | "preventDefault"
  >,
  body: HTMLElement | null,
) {
  if (
    !body ||
    event.key.toLowerCase() !== "a" ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    !(event.target instanceof HTMLElement) ||
    !event.currentTarget.contains(event.target) ||
    event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
  )
    return;
  const selection = body.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  event.preventDefault();
  const range = body.ownerDocument.createRange();
  range.selectNodeContents(body);
  selection.removeAllRanges();
  selection.addRange(range);
}
