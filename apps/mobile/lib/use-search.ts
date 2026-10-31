import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { querySpaceSearch } from "./search";
import { errorText } from "./user-error";

export function useSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const trimmed = query.trim();
    setHits([]);
    setError(null);
    setLoading(Boolean(trimmed));
    if (!trimmed) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void querySpaceSearch(trimmed)
        .then((hits) => {
          if (!abort.signal.aborted) setHits(hits);
        })
        .catch((reason: unknown) => {
          if (!abort.signal.aborted) setError(errorText(reason));
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
  return { hits, loading, error };
}
