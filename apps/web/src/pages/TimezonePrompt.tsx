import { Trans, useLingui } from "@lingui/react/macro";
import type { Me } from "@rakazo/contracts";
import { deviceTimezoneStep, localTimezone, timeZonePlace } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { keepTimezone, keptTimezones } from "../lib/kept-timezone";
import { useSave, useSpaceQueries } from "../lib/query";
import { rpc } from "../lib/rpc";
import { useEventListener } from "../lib/use-event-listener";

/**
 * Keeps the account's timezone in step with this device: adopts it for an account without
 * one, and asks before moving an account set to another zone. Checked on load and whenever
 * the window comes back, since that is when a trip or a move shows up.
 */
export function TimezonePrompt({
  userId,
  timezone,
  onSaved,
}: {
  userId: string;
  /** Undefined from a server that predates timezones, which leaves everything alone. */
  timezone: string | null | undefined;
  onSaved: (me: Me) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [device, setDevice] = useState(localTimezone);
  const kept = keptTimezones.use()[userId] ?? null;
  const step = timezone === undefined ? null : deviceTimezoneStep(device, timezone, kept);
  const recheck = () => {
    if (document.visibilityState === "visible") setDevice(localTimezone());
  };
  useEventListener(window, "focus", recheck);
  useEventListener(document, "visibilitychange", recheck);

  const switchZone = useSave({
    save: (zone: string, client) => client.preferences.update({ timezone: zone }),
    // Usage is grouped by day in the account's timezone.
    stale: [queries.usage.breakdown.key()],
    onSaved,
  });

  const adoptedFor = useRef<string | null>(null);
  const adopt = useEffectEvent(() => {
    // Only fills an empty zone, so it never replaces a choice; a failure leaves bots on UTC.
    void rpc.preferences
      .adoptTimezone({ timezone: device })
      .then(onSaved)
      .catch(() => {});
  });
  useEffect(() => {
    if (step !== "adopt" || adoptedFor.current === userId) return;
    adoptedFor.current = userId;
    adopt();
  }, [step, userId]);

  if (step !== "ask") return null;
  const place = timeZonePlace(device);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !switchZone.pending) keepTimezone(userId, device);
      }}
    >
      <AlertDialogContent data-testid="timezone-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans comment="Asks whether to move the account's timezone to this device's, e.g. 'Switch to Tokyo time?'">
              Switch to {place} time?
            </Trans>
          </AlertDialogTitle>
        </AlertDialogHeader>
        {switchZone.error ? (
          <p role="alert" className="text-body text-destructive">
            {t`Couldn't update your timezone`}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={switchZone.pending}>
            <Trans comment="Keeps the account's current timezone instead of switching">Keep</Trans>
          </AlertDialogCancel>
          <AlertDialogAction disabled={switchZone.pending} onClick={() => switchZone.run(device)}>
            <Trans comment="Switches the account's timezone to this device's">Switch</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
