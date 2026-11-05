import { useEffect, useState } from "react";

/** How long after the last resize event the window counts as still being resized. */
const RESIZE_SETTLE_MS = 160;

/**
 * The window's width, kept current as it resizes. While the window is being dragged, the root
 * carries `data-window-resizing` so the columns follow the edge directly instead of easing
 * behind it; their transitions return once the drag settles.
 */
export function useViewportWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const root = document.documentElement;
    const sync = () => {
      setWidth(window.innerWidth);
      root.setAttribute("data-window-resizing", "");
      clearTimeout(settle);
      settle = setTimeout(() => root.removeAttribute("data-window-resizing"), RESIZE_SETTLE_MS);
    };
    setWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
      clearTimeout(settle);
      root.removeAttribute("data-window-resizing");
    };
  }, []);
  return width;
}
