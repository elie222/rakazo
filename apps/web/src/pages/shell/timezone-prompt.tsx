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
import { keepTimezone, keptTimezones } from "../../lib/locale/kept-timezone";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { useEventListener } from "../../lib/use-event-listener";

/** The account after a timezone save, where an adoption only fills an empty zone and so never replaces a newer pick. */
export function withSavedTimezone(prev: Me | null | undefined, me: Me, adopted?: boolean) {
  if (!prev) return me;
  return adopted && prev.timezone != null ? prev : { ...prev, timezone: me.timezone };
}

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
  /** `adopted` when the save only filled an empty zone. */
  onSaved: (me: Me, adopted?: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [device, setDevice] = useState(localTimezone);
  const kept = keptTimezones.use()[userId] ?? null;
  const step = timezone === undefined ? null : deviceTimezoneStep(device, timezone, kept);
  // Bumped on each return so a failed adoption is tried again.
  const [returns, setReturns] = useState(0);
  const recheck = () => {
    if (document.visibilityState !== "visible") return;
    setDevice(localTimezone());
    setReturns((count) => count + 1);
  };
  useEventListener(window, "focus", recheck);
  useEventListener(document, "visibilitychange", recheck);

  const switchZone = useSave({
    save: (zone: string, client) => client.preferences.update({ timezone: zone }),
    // Usage is grouped by day in the account's timezone.
    stale: [queries.usage.breakdown.key()],
    onSaved: (me) => onSaved(me),
  });

  const adoptedFor = useRef<string | null>(null);
  const adopt = useEffectEvent(() => {
    if (adoptedFor.current === userId) return;
    adoptedFor.current = userId;
    // Only fills an empty zone, so it never replaces a choice; a failure leaves bots on UTC.
    void rpc.preferences
      .adoptTimezone({ timezone: device })
      .then((me) => {
        // The shell remounts this per account, so a late answer for another one is dropped.
        if (adoptedFor.current === userId) onSaved(me, true);
      })
      .catch(() => {
        // The next focus or visit tries again.
        adoptedFor.current = null;
      });
  });
  useEffect(() => {
    if (step === "adopt") adopt();
  }, [step, returns]);
  useEffect(
    () => () => {
      adoptedFor.current = null;
    },
    [],
  );

  if (step !== "ask") return null;
  const place = timeZonePlace(device);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !switchZone.pending && timezone)
          keepTimezone(userId, { device, account: timezone });
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
