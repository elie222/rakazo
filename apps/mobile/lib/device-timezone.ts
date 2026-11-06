import { localTimezone } from "@rakazo/core";
import { rpc } from "./api";

/** The account and zone this launch already reported, so polls and foreground returns stay quiet. */
let reported: { userId: string; timezone: string } | null = null;

/** Reports are sent one at a time, so two answers cannot commit in reverse order. */
let reports: Promise<void> = Promise.resolve();

/**
 * Confirmations this launch still owes: a failed report's write can commit on the server
 * anyway (a timeout or a dropped connection does not stop it) and land after a newer
 * report's, so after a failure the next successful report is followed by one more.
 */
let confirmationsOwed = 0;

/**
 * Reports this device's zone for the account, which follows it until the user picks a
 * zone by hand; the server keeps that choice. Called on the inbox load and whenever the
 * app returns to the foreground, so a zone the system changed while it was away lands
 * too. Quiet unless the zone moved since the last report of this launch; a failed report
 * is forgotten, so the next poll or foreground return tries again, and because its write
 * may still commit, one later poll confirms the zone once. Each report waits for the
 * previous one to settle, so the zone the server accepted last is the newest one.
 */
export function reportDeviceTimeZone(userId: string): Promise<void> {
  const timezone = localTimezone();
  if (confirmationsOwed === 0 && reported?.userId === userId && reported.timezone === timezone)
    return Promise.resolve();
  const attempt = { userId, timezone };
  reported = attempt;
  const report = reports.then(() =>
    rpc("preferences/adoptTimezone", { timezone }).then(() => {
      if (confirmationsOwed > 0) confirmationsOwed -= 1;
    }),
  );
  reports = report.catch(() => {});
  return report.catch((error: unknown) => {
    // Two are owed: the next report's success first, then one confirming send, so a write
    // that lands late cannot quietly beat what the marker remembers.
    confirmationsOwed = 2;
    if (reported === attempt) reported = null;
    throw error;
  });
}
