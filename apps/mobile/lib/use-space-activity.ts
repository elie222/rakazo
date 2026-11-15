import type { RunActivityRow } from "@rakazo/contracts";
import { isRetryableError } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSpaceActivity } from "./activity";
import { useForegroundPoll } from "./foreground-poll";
import { ACTIVITY_POLL_INTERVAL_MS } from "./poll-cadence";

export type SpaceActivityStatus = "loading" | "loaded" | "failed";

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
  const [activityStatus, setActivityStatus] = useState<SpaceActivityStatus>("loading");
  const activityRequestId = useRef(0);

  const clearActivity = useCallback(() => {
    setActivity({ active: [], recent: [] });
    setActivityStatus("loading");
  }, []);

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode) {
      activityRequestId.current += 1;
      clearActivity();
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
      setActivityStatus("loaded");
    } catch (error) {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
      setActivityStatus("failed");
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(error);
    }
  }, [activityMode, clearActivity, hasSession]);

  useForegroundPoll(loadActivity, ACTIVITY_POLL_INTERVAL_MS, hasSession && activityMode && inSight);

  useEffect(
    () => () => {
      activityRequestId.current += 1;
    },
    [activityMode, hasSession],
  );

  return { activity, activityStatus, clearActivity, activityRequestId, loadActivity };
}
