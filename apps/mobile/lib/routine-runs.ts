import type { RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { mergeRoutineRunPages, routineHistoryPage } from "@rakazo/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { queryClient, rpcQuery } from "./query";

/** A shown history asks again this often, so a running routine's status settles. */
export const ROUTINE_RUNS_POLL_MS = 15_000;

/** A routine's runs, newest first, a page at a time; refreshed while the screen is shown. */
export function useRoutineRuns(routineId: string) {
  const query = useInfiniteQuery(
    {
      queryKey: rpcQuery("routines/history", { routineId }).queryKey,
      queryFn: (context) =>
        rpcQuery("routines/history", routineHistoryPage(routineId, context.pageParam)).queryFn(
          context as never,
        ) as Promise<RoutineHistory>,
      initialPageParam: null as RoutineRunCursor | null,
      getNextPageParam: (page: RoutineHistory) => page.nextCursor,
      // The screen reads on focus and on a timer below.
      enabled: false,
    },
    queryClient,
  );
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      if (!routineId) return;
      void refetch();
      const timer = setInterval(() => void refetch(), ROUTINE_RUNS_POLL_MS);
      return () => clearInterval(timer);
    }, [routineId, refetch]),
  );
  return {
    runs: query.data ? mergeRoutineRunPages(query.data.pages) : null,
    failed: query.isError,
    hasOlder: query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => void query.fetchNextPage(),
    retry: () => void refetch(),
  };
}

/** Where a run's reply lives, opened at that message; null when it finished silently. */
export function routineRunDestination(run: RoutineRun, botName: string | undefined) {
  if (!run.messageId) return null;
  return run.groupId
    ? {
        pathname: "/group-thread" as const,
        params: { groupId: run.groupId, messageId: run.messageId },
      }
    : {
        pathname: "/thread" as const,
        params: {
          botId: run.botId,
          messageId: run.messageId,
          ...(botName ? { name: botName } : {}),
        },
      };
}
