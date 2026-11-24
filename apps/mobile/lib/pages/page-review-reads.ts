import { useIsFocused } from "expo-router";
import { useRosterSignals, useSpaceChanges } from "../api/roster-signals";
import { queryClient } from "../query/query";

export function usePageReviewSignals() {
  const focused = useIsFocused();
  useSpaceChanges(
    "pages",
    () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey.some(
            (key) =>
              typeof key === "string" &&
              (key.startsWith("pageReviews/") || key.startsWith("pages/")),
          ),
      }),
    focused,
  );
  const readStateAgain = () =>
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey.some((key) => typeof key === "string" && key.startsWith("pageReviews/state")),
    });
  useSpaceChanges("pageState", readStateAgain, focused);
  useRosterSignals(readStateAgain, focused);
}
