import type { RunActivityRow } from "@rakazo/contracts";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSpaceChanges } from "../api/roster-signals";
import { fetchSpaceActivity } from "./activity";

export type SpaceActivityStatus = "loading" | "loaded" | "failed";

/** The Space's running and recent work, read while the inbox is in sight. */
export function useSpaceActivity({
  hasSession,
  enabled,
  inSight,
  spaceActionRef,
}: {
  hasSession: boolean;
  /** Off for views that never show activity, such as the share picker. */
  enabled: boolean;
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
    if (!hasSession || !enabled) {
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
    } catch {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
      setActivityStatus("failed");
    }
  }, [enabled, clearActivity, hasSession]);

  const shown = hasSession && enabled && inSight;
  useEffect(() => {
    if (shown) void loadActivity();
  }, [shown, loadActivity]);
  useSpaceChanges("runs", loadActivity, shown);

  useEffect(
    () => () => {
      activityRequestId.current += 1;
    },
    [enabled, hasSession],
  );

  return { activity, activityStatus, clearActivity, activityRequestId, loadActivity };
}
