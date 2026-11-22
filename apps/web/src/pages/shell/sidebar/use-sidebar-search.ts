import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { SearchHit } from "@rakazo/contracts";
import { SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import { sliceWellFormed } from "@rakazo/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActivityListFilters } from "../../../lib/activity-list-filters";
import { emptyActivityFilters } from "../../../lib/activity-list-filters";
import { activityModePreference } from "../../../lib/preferences/activity-mode";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import type { useShellNavigation } from "../use-shell-navigation";

/** The sidebar's search box: it filters the roster, searches the space, or filters runs in Activity. */
export function useSidebarSearch({
  rpc,
  navigate,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResult, setSearchResult] = useState<{
    request: object;
    hits: SearchHit[];
    error: string | null;
  } | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const activityMode = activityModePreference.use();
  const [activityFilters, setActivityFilters] = useState<ActivityListFilters>(emptyActivityFilters);
  const [activityFiltersExpanded, setActivityFiltersExpanded] = useState(false);
  const activityFiltersId = useId();
  const activityFilterCount =
    Number(activityFilters.status !== "all") +
    Number(Boolean(activityFilters.dateRange.from)) +
    Number(Boolean(activityFilters.dateRange.to));
  const toggleActivityMode = useCallback(() => {
    setQuery("");
    setActivityFilters(emptyActivityFilters());
    setActivityFiltersExpanded(false);
    activityModePreference.set(!activityModePreference.get());
  }, []);
  const spaceQuery = query.trim();
  const showSpaceSearch = !activityMode && spaceQuery.length > 0;

  // Identify this query occurrence, not just its text: A → B → A must not revive old hits.
  // Use the full trimmed query, since different inputs can share the same capped RPC text.
  const request = useMemo(
    () => (showSpaceSearch ? { query: spaceQuery, attempt: searchAttempt } : null),
    [showSpaceSearch, spaceQuery, searchAttempt],
  );
  const currentResult = request && searchResult?.request === request ? searchResult : null;

  // Each query and retry gets its own signal, aborted once a newer one replaces it.
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!request) return;
    const abort = new AbortController();
    searchAbort.current = abort;
    return () => abort.abort();
  }, [request]);
  useTimeout(
    () => {
      const abort = searchAbort.current;
      if (!abort || !request) return;
      void rpc.search
        .query(
          { q: sliceWellFormed(request.query, SEARCH_QUERY_MAX_LENGTH) },
          { signal: abort.signal },
        )
        .then((result) => {
          if (!abort.signal.aborted) setSearchResult({ request, hits: result.hits, error: null });
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted)
            setSearchResult({ request, hits: [], error: errorText(error) });
        });
    },
    request ? 200 : null,
    request,
  );

  function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchOpen(false);
    const params = new URLSearchParams();
    if (hit.messageId) params.set("m", hit.messageId);
    if (hit.routineId) params.set("routine", hit.routineId);
    navigate({
      pathname: hit.groupId ? `/app/g/${hit.groupId}` : `/app/${hit.botId}`,
      search: params.toString() ? `?${params.toString()}` : undefined,
    });
  }

  return {
    query,
    setQuery,
    searchOpen,
    setSearchOpen,
    searchHits: currentResult?.hits ?? [],
    searchLoading: request !== null && currentResult === null,
    searchError: currentResult?.error ?? null,
    retrySearch: () => setSearchAttempt((attempt) => attempt + 1),
    showSpaceSearch,
    jumpToSearchHit,
    activityMode,
    toggleActivityMode,
    activityFilters,
    setActivityFilters,
    activityFiltersExpanded,
    setActivityFiltersExpanded,
    activityFiltersId,
    activityFilterCount,
  };
}

export type SidebarSearch = ReturnType<typeof useSidebarSearch>;
