import type { PageStateSave } from "@rakazo/chat-ui/hooks";
import { pageStateRetryable, usePageStateQueue } from "@rakazo/chat-ui/hooks";
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useAppForeground } from "../platform/app-foreground";
import { useSave } from "../query/query";
import type { SettingsTarget } from "../query/settings-target";

export function usePageStateSaver(
  pageId: string,
  options: { target?: SettingsTarget; stale?: readonly QueryKey[] } = {},
) {
  const queue = usePageStateQueue(pageId, (save) => saver.run(save));
  const saver = useSave({
    target: options.target,
    save: (input: PageStateSave, send) => send("pageReviews/saveState", input),
    stale: options.stale,
    onSaved: () => queue.saved(),
    onFailed: (error, input) => queue.failed(input, error),
  });
  const foreground = useAppForeground();
  const wasForeground = useRef(foreground);
  const { retry } = queue;
  useEffect(() => {
    if (foreground && !wasForeground.current) retry();
    wasForeground.current = foreground;
  }, [foreground, retry]);
  return {
    save: queue.save,
    failed: saver.error !== null && !saver.pending && pageStateRetryable(saver.error),
  };
}
