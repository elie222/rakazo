import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useRef } from "react";
import { useSave } from "../query/query";
import { useEventListener } from "../use-event-listener";

type Queued = { pageId: string; values: PageState };

export function usePageStateSaver(pageId: string, stale: readonly QueryKey[]) {
  const queued = useRef<Queued | null>(null);
  const sending = useRef(false);
  const next = useRef(() => {});
  const saver = useSave({
    save: (input: Queued, rpc) => rpc.pageReviews.saveState(input),
    stale,
    onSaved: () => {
      sending.current = false;
      next.current();
    },
    onFailed: (_error, input) => {
      sending.current = false;
      const later = queued.current?.pageId === input.pageId ? queued.current.values : {};
      queued.current = { pageId: input.pageId, values: { ...input.values, ...later } };
    },
  });
  next.current = () => {
    const input = queued.current;
    if (sending.current || !input || input.pageId !== pageId) return;
    queued.current = null;
    sending.current = true;
    saver.run(input);
  };
  const failed = saver.error !== null && !saver.pending;
  useEventListener(failed ? window : null, "focus", () => next.current());
  useEventListener(failed ? window : null, "online", () => next.current());
  return {
    save(values: PageState) {
      const earlier = queued.current?.pageId === pageId ? queued.current.values : {};
      queued.current = { pageId, values: { ...earlier, ...values } };
      next.current();
    },
    failed,
  };
}
