import { useEffect, useMemo, useState } from "react";
import { useEventListener } from "./use-event-listener";

/** Tracks one media query; missing `matchMedia` (jsdom, old browsers) reads as no match. */
export function useMediaQuery(query: string): boolean {
  const media = useMemo(
    () =>
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query)
        : null,
    [query],
  );
  const [matches, setMatches] = useState(() => media?.matches ?? false);

  useEffect(() => {
    setMatches(media?.matches ?? false);
  }, [media]);

  useEventListener(media, "change", (event) => setMatches(event.matches));

  return matches;
}
