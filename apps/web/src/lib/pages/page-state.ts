import type { PageStateSave } from "@rakazo/chat-ui/hooks";
import { pageStateRetryable, usePageStateQueue } from "@rakazo/chat-ui/hooks";
import type { QueryKey } from "@tanstack/react-query";
import { useSave } from "../query/query";
import { useEventListener } from "../use-event-listener";

export function usePageStateSaver(pageId: string, stale: readonly QueryKey[]) {
  const queue = usePageStateQueue(pageId, (save) => saver.run(save));
  const saver = useSave({
    save: (input: PageStateSave, rpc) => rpc.pageReviews.saveState(input),
    stale,
    onSaved: () => queue.saved(),
    onFailed: (error, input) => queue.failed(input, error),
  });
  const failed = saver.error !== null && !saver.pending && pageStateRetryable(saver.error);
  useEventListener(failed ? window : null, "focus", queue.retry);
  useEventListener(failed ? window : null, "online", queue.retry);
  return { save: queue.save, failed };
}
