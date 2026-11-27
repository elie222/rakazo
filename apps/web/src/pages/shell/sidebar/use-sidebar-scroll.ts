import { useCallback, useRef } from "react";

/** Own the roster's scroll position above the shell that remounts on Space changes. */
export function useSidebarScroll() {
  const scrollTop = useRef(0);
  return useCallback((list: HTMLDivElement | null) => {
    if (!list) return;
    list.scrollTop = scrollTop.current;
    return () => {
      scrollTop.current = list.scrollTop;
    };
  }, []);
}
