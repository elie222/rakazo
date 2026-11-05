import * as React from "react";

const MOBILE_BREAKPOINT = 768;
/** The narrowest window that still gets the desktop columns: an 80px rail beside a 400px thread. */
const DESKTOP_MIN_WIDTH = 480;
const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
/** Mirrors the `desk:` variant in styles.css. */
export const DESKTOP_LAYOUT_QUERY = `(min-width: ${MOBILE_BREAKPOINT}px), (min-width: ${DESKTOP_MIN_WIDTH}px) and ${FINE_POINTER_QUERY}`;

/** Whether the window shows the phone layout right now (the hook below tracks changes). */
export function phoneLayout() {
  const width = window.innerWidth;
  if (width >= MOBILE_BREAKPOINT) return false;
  if (width < DESKTOP_MIN_WIDTH) return true;
  // A narrow desktop window (mouse or trackpad) keeps the rail and the thread.
  return !(window.matchMedia?.(FINE_POINTER_QUERY).matches ?? false);
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const queries = [
      window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`),
      window.matchMedia(`(max-width: ${DESKTOP_MIN_WIDTH - 1}px)`),
      window.matchMedia(FINE_POINTER_QUERY),
    ];
    const onChange = () => setIsMobile(phoneLayout());
    for (const query of queries) query.addEventListener("change", onChange);
    setIsMobile(phoneLayout());
    return () => {
      for (const query of queries) query.removeEventListener("change", onChange);
    };
  }, []);

  return !!isMobile;
}

/** Below the classic 768px breakpoint, whatever the pointer (for surfaces styled with `md:`). */
export function useIsNarrow() {
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setNarrow(window.innerWidth < MOBILE_BREAKPOINT);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}
