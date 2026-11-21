import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

const FLIP_KEY = "data-flip-key";
const FLIP_DURATION = 200;
const FLIP_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

type Snapshot = {
  order: string;
  rects: Map<string, DOMRect>;
};

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Animates rows that change place when `revision` changes, using the Web Animations API. Rows opt
 * in with `data-flip-key`; the first paint stays still, and renders that keep the revision do not
 * measure the list, so streaming text beside it costs nothing.
 */
export function useFlip(container: RefObject<HTMLElement | null>, revision: string) {
  const snapshot = useRef<Snapshot | null>(null);
  const running = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(`[${FLIP_KEY}]`));
    const order = nodes
      .map((node) => node.getAttribute(FLIP_KEY))
      .filter((key): key is string => Boolean(key))
      .join("|");
    const previous = snapshot.current;
    const rects = new Map<string, DOMRect>();
    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY);
      if (key) rects.set(key, node.getBoundingClientRect());
    }
    snapshot.current = { order, rects };
    if (!previous || previous.order === order || prefersReducedMotion()) return;

    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY);
      if (!key) continue;
      const before = previous.rects.get(key);
      const after = rects.get(key);
      if (!before || !after) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      running.current.get(key)?.cancel();
      const animation = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: FLIP_DURATION, easing: FLIP_EASING },
      );
      running.current.set(key, animation);
    }
  }, [container, revision]);

  useLayoutEffect(() => {
    const animations = running.current;
    return () => {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    };
  }, []);
}
