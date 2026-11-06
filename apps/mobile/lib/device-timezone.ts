import { localTimezone } from "@rakazo/core";
import { rpc } from "./api";

/** The account and zone this launch already reported, so polls and foreground returns stay quiet. */
let reported: { userId: string; timezone: string } | null = null;

/** Reports are sent one at a time, so two answers cannot commit in reverse order. */
let reports: Promise<void> = Promise.resolve();

/**
 * Reports this device's zone for the account, which follows it until the user picks a
 * zone by hand; the server keeps that choice. Called on the inbox load and whenever the
 * app returns to the foreground, so a zone the system changed while it was away lands
 * too. Quiet unless the zone moved since the last report of this launch; a failed report
 * is forgotten, so the next poll or foreground return tries again. Each report waits for
 * the previous one to settle, so the zone the server accepted last is the newest one.
 */
export function reportDeviceTimeZone(userId: string): Promise<void> {
  const timezone = localTimezone();
  if (reported?.userId === userId && reported.timezone === timezone) return Promise.resolve();
  const attempt = { userId, timezone };
  reported = attempt;
  const report = reports.then(() => rpc("preferences/adoptTimezone", { timezone }).then(() => {}));
  reports = report.catch(() => {});
  return report.catch((error: unknown) => {
    if (reported === attempt) reported = null;
    throw error;
  });
}
