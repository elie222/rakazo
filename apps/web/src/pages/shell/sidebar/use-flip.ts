import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

const FLIP_KEY = "data-flip-key";
const FLIP_DURATION = 200;
const FLIP_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

type Snapshot = {
  order: string;
  /** Positions in the list's own scroll space, so scrolling between revisions cannot shift them. */
  positions: Map<string, { x: number; y: number }>;
  /** A resize changes every row's offset without changing the order; that is not a reorder. */
  width: number;
  height: number;
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
    // A FLIP from the previous revision may still be running. Cancel it before measuring,
    // otherwise the boxes below include that transform and a second reorder starts from a
    // position the row never held in layout.
    for (const animation of running.current.values()) animation.cancel();
    running.current.clear();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(`[${FLIP_KEY}]`));
    const order = nodes
      .map((node) => node.getAttribute(FLIP_KEY))
      .filter((key): key is string => Boolean(key))
      .join("|");
    const previous = snapshot.current;
    const rootRect = root.getBoundingClientRect();
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY);
      if (!key) continue;
      const rect = node.getBoundingClientRect();
      positions.set(key, {
        x: rect.left - rootRect.left + root.scrollLeft,
        y: rect.top - rootRect.top + root.scrollTop,
      });
    }
    snapshot.current = {
      order,
      positions,
      width: root.clientWidth,
      height: root.clientHeight,
    };
    if (
      !previous ||
      previous.order === order ||
      previous.width !== root.clientWidth ||
      previous.height !== root.clientHeight ||
      prefersReducedMotion()
    )
      return;

    for (const node of nodes) {
      const key = node.getAttribute(FLIP_KEY);
      if (!key) continue;
      const before = previous.positions.get(key);
      const after = positions.get(key);
      if (!before || !after) continue;
      const dx = before.x - after.x;
      const dy = before.y - after.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
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
