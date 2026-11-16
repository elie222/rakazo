import { useLayoutEffect } from "react";

let mounted = 0;

/**
 * Whether the root navigator is on screen. The imperative router throws while it is not, as when
 * Android destroys the activity during an async switch; the next mount starts at the inbox anyway.
 */
export function navigatorMounted(): boolean {
  return mounted > 0;
}

export function markNavigatorMounted(): () => void {
  mounted += 1;
  return () => {
    mounted -= 1;
  };
}

/** Called by the root layout; layout effects bind and unbind together with the router's own. */
export function useNavigatorMounted(): void {
  useLayoutEffect(markNavigatorMounted, []);
}
