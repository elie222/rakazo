import { useEffect, useRef, useState } from "react";

/** Copy text and report a short-lived "copied" flag for button feedback. */
export function useCopyText(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = (text: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return [copied, copy];
}
