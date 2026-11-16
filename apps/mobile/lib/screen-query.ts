import type { DataTag, QueryFunction, QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useAppForeground } from "./app-foreground";
import { queryClient } from "./query";

/**
 * A read for a screen: it paints what was last seen, and reads again each time the screen gains
 * focus and each time the app comes back to the foreground with the screen open. A form whose
 * draft a new read would replace passes `onForeground: false` and reads again on focus only.
 */
export function useScreenQuery<T>(
  read: { queryKey: DataTag<QueryKey, T, Error>; queryFn: QueryFunction<T> },
  { enabled = true, onForeground = true } = {},
) {
  const query = useQuery({ ...read, enabled }, queryClient);
  const { refetch } = query;
  const foreground = useAppForeground();
  const awake = onForeground ? foreground : true;
  useFocusEffect(
    useCallback(() => {
      // A read already in flight, such as the one opening the screen starts, is joined.
      if (enabled && awake) void refetch({ cancelRefetch: false });
    }, [enabled, awake, refetch]),
  );
  return query;
}
