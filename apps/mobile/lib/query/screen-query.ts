import type { QueryFunction, QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useAppForeground } from "../platform/app-foreground";
import { queryClient } from "./query";

/**
 * A read for a screen: it paints what was last seen, and reads again each time the screen gains
 * focus and each time the app comes back to the foreground with the screen open. A form whose
 * draft a new read would replace passes `onForeground: false` and reads again on focus only.
 * A read keyed by an immutable version can pass `onFocus: false` when another read checks freshness.
 */
export function useScreenQuery<T>(
  read: {
    queryKey: QueryKey;
    queryFn: QueryFunction<T>;
    gcTime?: number;
    meta?: Record<string, unknown>;
  },
  { enabled = true, onFocus = true, onForeground = true } = {},
) {
  const query = useQuery({ ...read, enabled }, queryClient);
  const { refetch } = query;
  const foreground = useAppForeground();
  const awake = onForeground ? foreground : true;
  useFocusEffect(
    useCallback(() => {
      // A read already in flight, such as the one opening the screen starts, is joined.
      if (enabled && onFocus && awake) void refetch({ cancelRefetch: false });
    }, [enabled, onFocus, awake, refetch]),
  );
  return query;
}
