import type { PageState } from "@rakazo/contracts";
import { errorCode } from "@rakazo/core";
import { useCallback, useRef } from "react";

export type PageStateSave = { pageId: string; values: PageState };

const REFUSED = new Set(["BAD_REQUEST", "PAGE_STATE_LIMIT"]);

/** Whether saving again could help: the server refuses the same values every time. */
export function pageStateRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return !(typeof code === "string" && REFUSED.has(code));
}

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
    if (sending.current || !save || save.pageId !== shown.current) return;
    queued.current = null;
    sending.current = true;
    send.current(save);
  }, []);
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
      if (!pageStateRetryable(error) || save.pageId !== shown.current) {
        next();
        return;
      }
      const later = queued.current?.pageId === save.pageId ? queued.current.values : {};
      queued.current = { pageId: save.pageId, values: { ...save.values, ...later } };
    },
    retry: next,
  };
}
