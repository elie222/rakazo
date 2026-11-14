import { useEffect, useState } from "react";

/** Rerenders at each local midnight, for labels that read today's date as they render ("Yesterday"). */
export function useRedrawAtMidnight() {
  const [day, setDay] = useState(() => new Date());
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(() => {
        setDay(new Date());
        schedule();
      }, midnight.getTime() - Date.now());
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return day;
}
