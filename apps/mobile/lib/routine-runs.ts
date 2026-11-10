import type { MessageBlock, RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import { mergeRoutineRunPages, plainTextFromMarkdown, routineHistoryPage } from "@rakazo/core";
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

/** A silent run's reply as plain text: what it wrote, then the steps it took. */
export function routineRunReplyText(blocks: readonly MessageBlock[] | undefined): string {
  const text = (blocks ?? [])
    .flatMap((block) =>
      block.kind === "text" ? [plainTextFromMarkdown(block.text, { maxSource: Infinity })] : [],
    )
    .join("\n\n")
    .trim();
  const steps = (blocks ?? []).flatMap((block) =>
    block.kind === "steps"
      ? block.steps.map((step) => `✓ ${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
      : [],
  );
  return [text, steps.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * Where a run's reply lives, opened at that message; null when it finished without one in the
 * chat, or kept it in the history because it is silent.
 */
export function routineRunDestination(run: RoutineRun, botName: string | undefined) {
  if (!run.messageId || run.reply?.length) return null;
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
