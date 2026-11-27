import type { RefObject } from "react";
import { useEffect, useState } from "react";

/** True once the element comes within about a screen of the viewport, or when `enabled` is off. */
export function useNearViewport(ref: RefObject<Element | null>, enabled = true) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return near || !enabled;
}
