import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

/** One confirmation per active visit. Visible embedded panes can override route focus. */
export function useConfirmationGuard(active?: boolean) {
  const visit = useRef<object | null>(null);
  const pending = useRef<object | null>(null);
  const activate = useCallback(() => {
    visit.current = {};
    return () => {
      visit.current = null;
      pending.current = null;
    };
  }, []);
  useFocusEffect(
    useCallback(() => (active === undefined ? activate() : undefined), [active, activate]),
  );
  useEffect(() => (active === true ? activate() : undefined), [active, activate]);
  return useCallback(() => {
    if (!visit.current || pending.current) return;
    const startedIn = visit.current;
    const request = {};
    pending.current = request;
    return {
      current: () => visit.current === startedIn && pending.current === request,
      finish: () => {
        if (pending.current === request) pending.current = null;
      },
    };
  }, []);
}
