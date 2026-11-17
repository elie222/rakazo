import type { RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { mergeRoutineRunPages, routineHistoryPage } from "@rakazo/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback } from "react";
import { queryClient, rpcQuery } from "./query";
import { useSpaceChanges } from "./roster-signals";

/** A routine's runs, newest first, a page at a time; read on focus and whenever runs change. */
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
      enabled: false,
    },
    queryClient,
  );
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      if (routineId) void refetch();
    }, [routineId, refetch]),
  );
  useSpaceChanges("runs", refetch, useIsFocused() && Boolean(routineId));
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
