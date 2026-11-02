import { useEffect, useRef } from "react";
import { desktopBridge } from "./desktop";

export function useDesktopBadge(count: number | undefined) {
  const badge = desktopBridge()?.badge;
  const lastCount = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (badge && lastCount.current !== undefined && lastCount.current !== 0)
        void badge.set(0).catch(() => undefined);
      lastCount.current = undefined;
    };
  }, [badge]);
  useEffect(() => {
    if (count === undefined) {
      lastCount.current = undefined;
      return;
    }
    if (!badge || lastCount.current === count) return;
    lastCount.current = count;
    void badge.set(count).catch(() => undefined);
  }, [badge, count]);
}
