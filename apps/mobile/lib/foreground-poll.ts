import { useEffect, useRef } from "react";
import { useAppForeground } from "./app-foreground";

/**
 * Runs one poll at a time while the screen is enabled and the app is visible.
 * The next run is scheduled only after the previous one finishes.
 */
export function useForegroundPoll(
  run: () => Promise<unknown>,
  intervalMs: number,
  enabled: boolean,
): void {
  const foreground = useAppForeground();
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled || !foreground) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const tick = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        await runRef.current();
      } finally {
        running = false;
        if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, foreground, intervalMs]);
}
