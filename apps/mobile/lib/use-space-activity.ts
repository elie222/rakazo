import type { RunActivityRow } from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSpaceActivity } from "./activity";
import { useForegroundPoll } from "./foreground-poll";
import { ACTIVITY_POLL_INTERVAL_MS } from "./poll-cadence";

/** The Space's running and recent work, polled while the activity view is on and in sight. */
export function useSpaceActivity({
  hasSession,
  activityMode,
  inSight,
  spaceActionRef,
}: {
  hasSession: boolean;
  activityMode: boolean;
  inSight: boolean;
  spaceActionRef: RefObject<{ busy: boolean; recoveryId: string | null }>;
}) {
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch (error) {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(error);
    }
  }, [activityMode, hasSession]);

  useForegroundPoll(loadActivity, ACTIVITY_POLL_INTERVAL_MS, hasSession && activityMode && inSight);

  useEffect(
    () => () => {
      activityRequestId.current += 1;
    },
    [activityMode, hasSession],
  );

  return { activity, setActivity, activityRequestId, loadActivity };
}
