import { useIsFocused } from "expo-router";
import { useSpaceChanges } from "../api/roster-signals";
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
}
