import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { SearchHit } from "@rakazo/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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

  // Each query and retry gets its own signal, aborted once a newer one replaces it.
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }
    const abort = new AbortController();
    searchAbort.current = abort;
    return () => abort.abort();
  }, [showSpaceSearch, spaceQuery, searchAttempt]);
  useTimeout(
    () => {
      const abort = searchAbort.current;
      if (!abort) return;
      setSearchLoading(true);
      setSearchError(null);
      void rpc.search
        .query({ q: spaceQuery }, { signal: abort.signal })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setSearchError(errorText(error));
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    },
    showSpaceSearch ? 200 : null,
    `${spaceQuery}\n${searchAttempt}`,
  );

  function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchOpen(false);
    setSearchHits([]);
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
    searchHits,
    searchLoading,
    searchError,
    retrySearch: () => {
      setSearchLoading(true);
      setSearchAttempt((attempt) => attempt + 1);
    },
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
