import { useTimeout } from "@rakazo/chat-ui/hooks";
import { nextChatWake } from "@rakazo/core";
import { useMemo, useState } from "react";
import { useEventListener } from "../../lib/use-event-listener";

// Longer waits re-check, since browsers cap timers and a sleeping laptop stalls them.
const MAX_WAIT_MS = 60 * 60 * 1000;

/** The time the roster reads snoozes against, moved forward when one of these chats wakes. */
export function useSnoozeClock(chats: Iterable<{ snoozedUntil?: string | null }>) {
  const [now, setNow] = useState(Date.now);
  // Against the clock the roster reads, so a wake that passed since it last moved ticks at once.
  const next = nextChatWake(chats, now);
  const wait = useMemo(
    () => (next === null ? null : Math.min(Math.max(next - Date.now(), 0), MAX_WAIT_MS)),
    [next, now],
  );
  const tick = () => setNow(Date.now());
  useEventListener(window, "focus", tick);
  useTimeout(tick, wait, now);
  return now;
}
