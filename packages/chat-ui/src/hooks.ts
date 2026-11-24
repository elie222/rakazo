import type { PageState } from "@rakazo/contracts";
import type { ListSearchOptions } from "@rakazo/core";
import { errorCode, listSearch } from "@rakazo/core";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

/**
 * Calls `callback` once, `ms` after mount. A new `ms` or `restartKey` starts the wait again and
 * `null` cancels it; the latest callback runs, and nothing runs after unmount.
 */
export function useTimeout(callback: () => void, ms: number | null, restartKey?: unknown): void {
  const fire = useEffectEvent(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setTimeout(() => fire(), ms);
    return () => clearTimeout(timer);
  }, [ms, restartKey]);
}

/** `Date.now()`, refreshed every `ms` while it is not `null` and at once when it resumes. */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** A list filtered by a search box's query, with the query state the box binds to. */
export function useListSearch<T>(items: readonly T[], options: ListSearchOptions<T>) {
  const [query, setQuery] = useState("");
  return { query, setQuery, ...listSearch(items, query, options) };
}

export type PageStateSave = { pageId: string; values: PageState };

const REFUSED = new Set(["BAD_REQUEST", "PAGE_STATE_LIMIT"]);

/**
 * What a reader changed on a page, saved one request at a time: changes made while one is out go
 * in the next, a failed one goes again with the next, and one the server refused is dropped.
 */
export function usePageStateQueue(pageId: string, run: (save: PageStateSave) => void) {
  const send = useRef(run);
  send.current = run;
  const queued = useRef<PageStateSave | null>(null);
  const sending = useRef(false);
  const shown = useRef(pageId);
  shown.current = pageId;
  const next = useCallback(() => {
    const save = queued.current;
    if (sending.current || !save || save.pageId !== pageId) return;
    queued.current = null;
    sending.current = true;
    send.current(save);
  }, [pageId]);
  return {
    save(values: PageState) {
      const earlier = queued.current?.pageId === pageId ? queued.current.values : {};
      queued.current = { pageId, values: { ...earlier, ...values } };
      next();
    },
    saved() {
      sending.current = false;
      next();
    },
    failed(save: PageStateSave, error: unknown) {
      sending.current = false;
      const code = errorCode(error);
      if ((typeof code === "string" && REFUSED.has(code)) || save.pageId !== shown.current) {
        next();
        return;
      }
      const later = queued.current?.pageId === save.pageId ? queued.current.values : {};
      queued.current = { pageId: save.pageId, values: { ...save.values, ...later } };
    },
    retry: next,
  };
}
