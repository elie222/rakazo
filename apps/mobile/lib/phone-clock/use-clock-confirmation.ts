import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type ClockConfirmation = { title: string; message: string };
export type ClockPrompt = ClockConfirmation & {
  expiresAt: number;
  settle(accepted: boolean): void;
};
export type ConfirmClock = (
  details: ClockConfirmation,
  expiresAt: number,
  signal: AbortSignal,
) => Promise<boolean>;

export function useClockConfirmation() {
  const [state, setState] = useState<ClockPrompt | { release(unmounted: boolean): void }>();
  const mounted = useRef(false);
  const pendingClose = useRef<(unmounted: boolean) => void>(undefined);
  const prompt = state && "settle" in state ? state : undefined;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingClose.current?.(true);
    };
  }, []);
  useLayoutEffect(() => {
    // Let the declarative dialog unmount before another capability can present.
    if (state && "release" in state) state.release(false);
  }, [state]);

  const confirmClock = useCallback<ConfirmClock>(
    (details, expiresAt, signal) =>
      new Promise((resolve) => {
        const eligible = () => mounted.current && !signal.aborted && performance.now() < expiresAt;
        if (!eligible()) return resolve(false);
        let settled = false;
        const settle = (accepted: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          if (!mounted.current) return resolve(false);
          const release = (unmounted: boolean) => {
            pendingClose.current = undefined;
            resolve(!unmounted && accepted && eligible());
          };
          pendingClose.current = release;
          setState({ release });
        };
        const abort = () => settle(false);
        signal.addEventListener("abort", abort, { once: true });
        setState({ ...details, expiresAt, settle });
      }),
    [],
  );

  useTimeout(
    () => prompt?.settle(false),
    prompt ? Math.max(0, prompt.expiresAt - performance.now()) : null,
    prompt,
  );
  return { prompt, confirmClock };
}
