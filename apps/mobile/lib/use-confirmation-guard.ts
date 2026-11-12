import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";

/** One confirmation per focused screen visit, including its asynchronous preparation. */
export function useConfirmationGuard() {
  const visit = useRef<object | null>(null);
  const pending = useRef<object | null>(null);
  useFocusEffect(
    useCallback(() => {
      visit.current = {};
      return () => {
        visit.current = null;
        pending.current = null;
      };
    }, []),
  );
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
