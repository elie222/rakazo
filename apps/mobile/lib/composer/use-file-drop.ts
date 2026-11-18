import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import type { DropLimits, DropPayload } from "./file-drop";
import { addDropTarget } from "./file-drop";

export function useFileDrop(
  key: string | null,
  handler: (payload: DropPayload) => void,
  limits: DropLimits,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  const latestLimits = useRef(limits);
  latestLimits.current = limits;
  const registration = useRef<ReturnType<typeof addDropTarget> | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (key === null) return;
      const target = addDropTarget(key, (payload) => latest.current(payload), latestLimits.current);
      registration.current = target;
      return () => {
        target();
        registration.current = null;
      };
    }, [key]),
  );
  useEffect(() => {
    registration.current?.update(limits);
  }, [limits.enabled, limits.maxBytes, limits.maxFiles]);
}
