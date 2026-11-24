import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useRef } from "react";
import { useSave } from "../query/query";

export function usePageStateSaver(pageId: string, stale: readonly QueryKey[]) {
  const queued = useRef<PageState>({});
  const sending = useRef(false);
  const next = useRef(() => {});
  const saver = useSave({
    save: (values: PageState, rpc) => rpc.pageReviews.saveState({ pageId, values }),
    stale,
    onSaved: () => {
      sending.current = false;
      next.current();
    },
    onFailed: (_error, values) => {
      sending.current = false;
      queued.current = { ...values, ...queued.current };
    },
  });
  next.current = () => {
    if (sending.current || Object.keys(queued.current).length === 0) return;
    const values = queued.current;
    queued.current = {};
    sending.current = true;
    saver.run(values);
  };
  return {
    save(values: PageState) {
      queued.current = { ...queued.current, ...values };
      next.current();
    },
    failed: saver.error !== null && !saver.pending,
  };
}
