import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useRef } from "react";
import { useSave } from "../query/query";
import type { SettingsTarget } from "../query/settings-target";

export function usePageStateSaver(
  pageId: string,
  options: { target?: SettingsTarget; stale?: readonly QueryKey[] } = {},
) {
  const queued = useRef<PageState>({});
  const sending = useRef(false);
  const next = useRef(() => {});
  const saver = useSave({
    target: options.target,
    save: (values: PageState, send) => send("pageReviews/saveState", { pageId, values }),
    stale: options.stale,
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
