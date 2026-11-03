import { useEffect, useRef, useState } from "react";

/**
 * Copies by selecting the text in a hidden field, which works in the click that asked for it
 * where the Clipboard API does not exist: a self-hosted server on plain http, for one.
 */
function copyBySelection(text: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // Next to the focused control, so a dialog's focus trap lets the selection happen.
  (active?.parentElement ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  active?.focus({ preventScroll: true });
  return copied;
}

/**
 * Puts text on the clipboard; true once there. Browsers expose the Clipboard API only to secure
 * pages, so its absence is the insecure case.
 */
export function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyBySelection(text),
    );
  }
  return Promise.resolve(copyBySelection(text));
}

/**
 * Copy text and report a short-lived "copied" flag for button feedback, and whether the last
 * copy failed so the caller can offer the text to select by hand.
 */
export function useCopyText(): [copied: boolean, copy: (text: string) => void, failed: boolean] {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = (text: string) => {
    void writeClipboard(text).then((ok) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      setState(ok ? "copied" : "failed");
      if (ok) timerRef.current = window.setTimeout(() => setState("idle"), 2000);
    });
  };

  return [state === "copied", copy, state === "failed"];
}
