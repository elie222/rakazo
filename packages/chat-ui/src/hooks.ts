import type { PageState } from "@rakazo/contracts";
import type { ListSearchOptions } from "@rakazo/core";
import { listSearch } from "@rakazo/core";
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

const pageStateQueues = new Map<string, { queued: PageState; sending: PageState | null }>();

function pageStateQueue(pageId: string) {
  let queue = pageStateQueues.get(pageId);
  if (!queue) {
    queue = { queued: {}, sending: null };
    pageStateQueues.set(pageId, queue);
  }
  return queue;
}

function requeue(pageId: string) {
  const queue = pageStateQueue(pageId);
  if (queue.sending) queue.queued = { ...queue.sending, ...queue.queued };
  queue.sending = null;
}

/**
 * What a reader changed on a page, saved one request at a time: changes made while one is out go
 * in the next, a failed one goes again with the next, and one whose answer never came back because
 * the page closed goes again when it opens.
 */
export function usePageStateQueue(pageId: string, run: (save: PageStateSave) => void) {
  const send = useRef(run);
  send.current = run;
  const next = useCallback(() => {
    const queue = pageStateQueue(pageId);
    if (queue.sending || Object.keys(queue.queued).length === 0) return;
    queue.sending = queue.queued;
    queue.queued = {};
    send.current({ pageId, values: queue.sending });
  }, [pageId]);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === pageId) return;
    opened.current = pageId;
    requeue(pageId);
    next();
  }, [pageId, next]);
  return {
    save(values: PageState) {
      const queue = pageStateQueue(pageId);
      queue.queued = { ...queue.queued, ...values };
      next();
    },
    saved(save: PageStateSave) {
      pageStateQueue(save.pageId).sending = null;
      if (save.pageId === pageId) next();
    },
    failed(save: PageStateSave) {
      requeue(save.pageId);
    },
    retry: next,
  };
}
