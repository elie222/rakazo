import {
  createRefreshCoalescer,
  isRunTerminalEvent,
  isThreadSnapshotEvent,
  reduceThreadSnapshot,
  runThreadSubscription,
} from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { SpaceQueries } from "../../../lib/query/query";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { useEventListener } from "../../../lib/use-event-listener";

/**
 * One topic's thread, read through the query cache and kept live by its own subscription, the
 * way the main chat follows its thread. It is marked read whenever it is on screen and changes.
 */
export function useTopicThread({
  rpc,
  queries,
  botId,
  topicId,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  botId: string;
  topicId: string;
}) {
  const queryClient = useQueryClient();
  const target = useMemo(() => ({ botId, topicId }), [botId, topicId]);
  const options = queries.threads.get.queryOptions({ input: target });
  const snapshot = useQuery(options).data ?? null;
  const topicsKey = queries.threads.topics.queryKey({ input: { botId } });

  const markRead = useRef(() => {});
  markRead.current = () => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    // The RPC client reports a failed request; the next open or focus marks it read again.
    void rpc.threads
      .markRead(target)
      .then(() => queryClient.invalidateQueries({ queryKey: topicsKey }))
      .catch(() => undefined);
  };
  useEventListener(window, "focus", () => markRead.current());

  useEffect(() => {
    const abort = new AbortController();
    const key = options.queryKey;
    const refresh = () => fetchFresh(queryClient, options);
    const coalesced = createRefreshCoalescer(refresh);
    void runThreadSubscription({
      signal: abort.signal,
      // Joins the read the query itself started on mount.
      loadInitial: async () => {
        const loaded = await fetchFresh(queryClient, options, { reuse: true });
        markRead.current();
        return loaded;
      },
      loadHead: () => rpc.threads.head(target, { signal: abort.signal }),
      refresh,
      currentSnapshot: () => queryClient.getQueryData(key) ?? null,
      subscribe: (cursor, signal) => rpc.threads.subscribe({ ...target, cursor }, { signal }),
      applyEvent: (event) => {
        if (!isThreadSnapshotEvent(event)) return;
        queryClient.setQueryData(key, (prev) => reduceThreadSnapshot(prev ?? null, event) ?? prev);
      },
      onEvent: (event) => {
        if (event.type === "thread.message.created") {
          markRead.current();
          void queryClient.invalidateQueries({ queryKey: topicsKey });
        }
        // waiting_input: an ask card's answerable state comes with the snapshot.
        if (isRunTerminalEvent(event) || event.type === "run.waiting_input") {
          // A failed read is reported by the RPC client; the next event reads again.
          void coalesced.invalidate().catch(() => undefined);
        }
      },
    });
    return () => {
      coalesced.dispose();
      abort.abort();
    };
  }, [botId, topicId]);

  return { snapshot, target, refresh: () => fetchFresh(queryClient, options) };
}
