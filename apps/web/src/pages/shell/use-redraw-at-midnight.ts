import { useTimeout } from "@rakazo/chat-ui/hooks";
import { useMemo, useState } from "react";

/** Rerenders at each local midnight, for labels that read today's date as they render ("Yesterday"). */
export function useRedrawAtMidnight() {
  const [day, setDay] = useState(() => new Date());
  const untilMidnight = useMemo(() => {
    const midnight = new Date(day);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - Date.now();
  }, [day]);
  // Keyed on the day: two nights can leave the same delay, which alone would not restart it.
  useTimeout(() => setDay(new Date()), untilMidnight, day);
  return day;
}
