import type { PageStateSave } from "@rakazo/chat-ui/page-state";
import { pageStateRetryable, usePageStateQueue, withSavedValues } from "@rakazo/chat-ui/page-state";
import type { PageState } from "@rakazo/contracts";
import type { QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useAppForeground } from "../platform/app-foreground";
import { queryClient, useSave } from "../query/query";
import type { SettingsTarget } from "../query/settings-target";

export function usePageStateSaver(
  pageId: string,
  /** `read` is the page read kept showing what was saved. */
  options: { target?: SettingsTarget; read?: QueryKey } = {},
) {
  const queue = usePageStateQueue(pageId, (save) => saver.run(save));
  const saver = useSave({
    target: options.target,
    save: (input: PageStateSave, send) => send("pageReviews/saveState", input),
    onSaved: (_, input) => {
      const { read } = options;
      if (read) {
        queryClient.setQueryData<{ readerState?: PageState }>(read, (cached) =>
          withSavedValues(cached, input.values),
        );
      }
      queue.saved();
    },
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
