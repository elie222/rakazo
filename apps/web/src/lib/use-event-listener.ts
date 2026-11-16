import { useEffect, useEffectEvent } from "react";

type EventMap<T> = T extends Window
  ? WindowEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends HTMLElement
      ? HTMLElementEventMap
      : T extends MediaQueryList
        ? MediaQueryListEventMap
        : T extends VisualViewport
          ? VisualViewportEventMap
          : Record<string, Event>;

/**
 * Listens for `type` on `target` while it is not `null`. The latest handler runs without
 * re-subscribing; a new target, type or options re-subscribes, and unmounting removes it.
 */
export function useEventListener<T extends EventTarget, K extends keyof EventMap<T> & string>(
  target: T | null | undefined,
  type: K,
  handler: (event: EventMap<T>[K]) => void,
  // A null target stops listening; there is no signal to pass.
  options?: boolean | Omit<AddEventListenerOptions, "signal">,
): void {
  const listener = useEffectEvent((event: Event) => handler(event as EventMap<T>[K]));
  const capture = typeof options === "boolean" ? options : options?.capture;
  const passive = typeof options === "boolean" ? undefined : options?.passive;
  const once = typeof options === "boolean" ? undefined : options?.once;
  useEffect(() => {
    if (!target) return;
    const onEvent = (event: Event) => listener(event);
    target.addEventListener(type, onEvent, { capture, passive, once });
    return () => target.removeEventListener(type, onEvent, capture);
  }, [target, type, capture, passive, once]);
}
