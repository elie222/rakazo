import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { SearchHit } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../api/user-error";
import { normalizeSpaceSearchQuery, querySpaceSearch } from "./search";

export function useSearch(query: string) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = normalizeSpaceSearchQuery(query);
  // Each query and retry gets its own signal, aborted once a newer one replaces it.
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    setHits([]);
    setError(null);
    setLoading(Boolean(requestKey));
    if (!requestKey) return;
    const abort = new AbortController();
    searchAbort.current = abort;
    return () => abort.abort();
  }, [requestKey, attempt]);
  useTimeout(
    () => {
      const abort = searchAbort.current;
      if (!abort) return;
      // Pass raw input: trimming the capped key could drop a space at the cut.
      void querySpaceSearch(query, abort.signal)
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
    requestKey ? 200 : null,
    `${requestKey}\n${attempt}`,
  );
  return { hits, loading, error, retry: () => setAttempt((value) => value + 1) };
}
