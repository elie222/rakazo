import { useTimeout } from "@rakazo/chat-ui/hooks";
import { nextChatWake } from "@rakazo/core";
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";

// Longer waits re-check, since a suspended app's timers stall.
const MAX_WAIT_MS = 60 * 60 * 1000;

/** The time the inbox reads snoozes against, moved forward when one of these chats wakes. */
export function useSnoozeClock(chats: Iterable<{ snoozedUntil?: string | null }>) {
  const [now, setNow] = useState(Date.now);
  // Against the clock the roster reads, so a wake that passed since it last moved ticks at once.
  const next = nextChatWake(chats, now);
  const wait = useMemo(
    () => (next === null ? null : Math.min(Math.max(next - Date.now(), 0), MAX_WAIT_MS)),
    [next, now],
  );
  const tick = () => setNow(Date.now());
  useTimeout(tick, wait, now);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);
  return now;
}
