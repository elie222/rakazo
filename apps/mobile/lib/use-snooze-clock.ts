import { nextChatWake } from "@rakazo/core";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

// Longer waits re-check, since a suspended app's timers stall.
const MAX_WAIT_MS = 60 * 60 * 1000;

/** The time the inbox reads snoozes against, moved forward when one of these chats wakes. */
export function useSnoozeClock(chats: Iterable<{ snoozedUntil?: string | null }>) {
  const [now, setNow] = useState(Date.now);
  // Against the clock the roster reads, so a wake that passed since it last moved ticks at once.
  const next = nextChatWake(chats, now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") tick();
    });
    const timer =
      next === null
        ? undefined
        : setTimeout(tick, Math.min(Math.max(next - Date.now(), 0), MAX_WAIT_MS));
    return () => {
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [next, now]);
  return now;
}
