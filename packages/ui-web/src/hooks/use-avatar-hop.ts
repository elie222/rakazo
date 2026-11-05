import type { AnimationEvent } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * True for one playful hop after `look` (a bot's colour or shape) changes, never on first
 * render. Pass `onAnimationEnd` to the element that plays the `avatar-hop` keyframes.
 */
export function useAvatarHop(look: string) {
  const [hopping, setHopping] = useState(false);
  const shown = useRef(look);
  useEffect(() => {
    if (shown.current === look) return;
    shown.current = look;
    setHopping(true);
  }, [look]);
  const onAnimationEnd = (event: AnimationEvent<Element>) => {
    if (event.animationName === "avatar-hop") setHopping(false);
  };
  return { hopping, onAnimationEnd };
}
