import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useAppForeground } from "../platform/app-foreground";
import { useSave } from "../query/query";
import type { SettingsTarget } from "../query/settings-target";

type Queued = { pageId: string; values: PageState };

export function usePageStateSaver(
  pageId: string,
  options: { target?: SettingsTarget; stale?: readonly QueryKey[] } = {},
) {
  const queued = useRef<Queued | null>(null);
  const sending = useRef(false);
  const next = useRef(() => {});
  const saver = useSave({
    target: options.target,
    save: (input: Queued, send) => send("pageReviews/saveState", input),
    stale: options.stale,
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
  const foreground = useAppForeground();
  const wasForeground = useRef(foreground);
  useEffect(() => {
    if (foreground && !wasForeground.current) next.current();
    wasForeground.current = foreground;
  }, [foreground]);
  return {
    save(values: PageState) {
      const earlier = queued.current?.pageId === pageId ? queued.current.values : {};
      queued.current = { pageId, values: { ...earlier, ...values } };
      next.current();
    },
    failed,
  };
}
