import type { Me } from "@rakazo/contracts";
import { localTimezone } from "@rakazo/core";
import { useCallback, useEffect, useRef } from "react";
import type { createSpaceRpc } from "../../lib/rpc";

/**
 * Reports the device's zone for the account whenever the shell's `me` arrives, its saved
 * zone changes under it (a cached seed replaced by the fresh bootstrap), or the tab
 * returns to the foreground, while the saved zone differs from the device's. The server
 * keeps a zone the user picked by hand, so a report never fights a choice; a report whose
 * answer arrives after a newer manual save is dropped, so a delayed answer cannot repaint
 * the zone that choice just showed.
 *
 * Returns the marker every manual timezone save bumps.
 */
export function useDeviceTimezoneReport(
  rpc: ReturnType<typeof createSpaceRpc>,
  me: Me | null | undefined,
  applyTimezone: (nextMe: Me) => void,
) {
  const choiceEpoch = useRef(0);
  const stateRef = useRef({ rpc, me, applyTimezone });
  stateRef.current = { rpc, me, applyTimezone };
  const report = useCallback(() => {
    const { rpc, me, applyTimezone } = stateRef.current;
    const deviceTimezone = localTimezone();
    if (document.visibilityState !== "visible" || !me || me.timezone === deviceTimezone) return;
    const sent = choiceEpoch.current;
    void rpc.preferences
      .adoptTimezone({ timezone: deviceTimezone })
      .then((nextMe) => {
        // A manual save landed since this report was sent: its zone stays on screen.
        if (choiceEpoch.current === sent) applyTimezone(nextMe);
      })
      .catch(() => {});
  }, []);
  const hasMe = me != null;
  const savedZone = me?.timezone ?? null;
  useEffect(() => {
    if (hasMe) report();
  }, [hasMe, savedZone, report]);
  useEffect(() => {
    const onForeground = () => report();
    document.addEventListener("visibilitychange", onForeground);
    return () => document.removeEventListener("visibilitychange", onForeground);
  }, [report]);
  /** Bumped by each manual timezone save: reports sent before it never repaint. */
  return useCallback(() => {
    choiceEpoch.current += 1;
  }, []);
}
