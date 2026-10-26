import type { SearchHit } from "@rakazo/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import type { ActivityListFilters } from "../../lib/activity-list-filters";
import { emptyActivityFilters } from "../../lib/activity-list-filters";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";
import type { createSpaceRpc } from "../../lib/rpc";
import type { useShellNavigation } from "./use-shell-navigation";

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
  const [activityMode, setActivityMode] = useState(readActivityMode);
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
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);
  const spaceQuery = query.trim();
  const showSpaceSearch = !activityMode && spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

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
