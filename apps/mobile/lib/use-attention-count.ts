import { isRetryableError } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { selectedSpaceId } from "./api";
import { subscribeConfirmedSpaceSwitch } from "./api-server";
import { fetchAttentionItems } from "./attention";
import { useForegroundPoll } from "./foreground-poll";
import { ATTENTION_POLL_INTERVAL_MS } from "./poll-cadence";

/** How many items are waiting on the user, polled while the inbox is in sight. */
export function useAttentionCount({
  hasSession,
  inSight,
  spaceActionRef,
}: {
  hasSession: boolean;
  inSight: boolean;
  spaceActionRef: RefObject<{ busy: boolean; recoveryId: string | null }>;
}) {
  const [attentionCount, setAttentionCount] = useState(0);
  const attentionRequestId = useRef(0);
  const spaceId = useSyncExternalStore(
    subscribeConfirmedSpaceSwitch,
    selectedSpaceId,
    selectedSpaceId,
  );
  const loadedSpaceId = useRef(spaceId);

  /** Drop the count and any response still in flight, as when switching spaces. */
  const resetAttention = useCallback(() => {
    attentionRequestId.current += 1;
    setAttentionCount(0);
  }, []);

  const loadAttention = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession) {
      resetAttention();
      return;
    }
    const requestId = ++attentionRequestId.current;
    try {
      const next = await fetchAttentionItems();
      if (requestId !== attentionRequestId.current) return;
      setAttentionCount(next.length);
    } catch (error) {
      if (requestId !== attentionRequestId.current) return;
      // A refused request would stay refused; keep the last count and stop polling.
      return isRetryableError(error);
    }
  }, [hasSession, resetAttention, spaceActionRef]);

  useForegroundPoll(loadAttention, ATTENTION_POLL_INTERVAL_MS, hasSession && inSight);

  useEffect(() => {
    if (loadedSpaceId.current === spaceId) return;
    loadedSpaceId.current = spaceId;
    // A chat route can switch Spaces under a mounted Home; drop the old count first.
    resetAttention();
    void loadAttention();
  }, [loadAttention, resetAttention, spaceId]);

  useEffect(
    () => () => {
      attentionRequestId.current += 1;
    },
    [],
  );

  return { attentionCount, loadAttention, resetAttention };
}
