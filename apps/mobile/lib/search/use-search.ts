import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../api/user-error";
import { querySpaceSearch } from "./search";

export function useSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const trimmed = query.trim();
  // Each query and retry gets its own signal, aborted once a newer one replaces it.
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    setHits([]);
    setError(null);
    setLoading(Boolean(trimmed));
    if (!trimmed) return;
    const abort = new AbortController();
    searchAbort.current = abort;
    return () => abort.abort();
  }, [query, attempt]);
  useTimeout(
    () => {
      const abort = searchAbort.current;
      if (!abort) return;
      void querySpaceSearch(trimmed, abort.signal)
        .then((hits) => {
          if (!abort.signal.aborted) setHits(hits);
        })
        .catch((reason: unknown) => {
          if (!abort.signal.aborted) setError(errorText(reason));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    },
    trimmed ? 200 : null,
    `${query}\n${attempt}`,
  );
  return { hits, loading, error, retry: () => setAttempt((value) => value + 1) };
}
