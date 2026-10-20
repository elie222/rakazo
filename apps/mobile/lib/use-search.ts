import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { querySpaceSearch } from "./search";

export function useSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const trimmed = query.trim();
    setHits([]);
    setLoading(Boolean(trimmed));
    if (!trimmed) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void querySpaceSearch(trimmed)
        .then((hits) => {
          if (!abort.signal.aborted) setHits(hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query]);
  return { hits, loading };
}
