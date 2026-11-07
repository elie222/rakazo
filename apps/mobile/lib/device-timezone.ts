import { localTimezone } from "@rakazo/core";
import { rpc } from "./api";

/** The report this device still owes: in flight, or queued behind an earlier one. */
let pending: { userId: string; timezone: string; report: Promise<void> } | null = null;

/** Reports are sent one at a time, so two answers cannot commit in reverse order. */
let reports: Promise<void> = Promise.resolve();

/** The hand-picked zone the server kept against this device's report, so polls stay quiet. */
let pinned: { userId: string; timezone: string } | null = null;

/**
 * Reports this device's zone for the account, which follows it until the user picks a
 * zone by hand; the server keeps that choice. The inbox load calls this with the zone
 * the same poll's `me` brought, and so does every foreground return, so a zone the
 * system changed while the app was away lands too. A report goes out only while the
 * server's zone differs from this device's, so a write that lands late is caught by the
 * next comparison instead of being remembered. One report is in flight at a time:
 * identical calls share it, a different zone or account queues behind it.
 */
export function reportDeviceTimeZone(
  userId: string,
  serverZone: string | null | undefined,
): Promise<void> {
  const timezone = localTimezone();
  if (serverZone === timezone) return Promise.resolve();
  if (pinned?.userId === userId && pinned.timezone === serverZone) return Promise.resolve();
  if (pending?.userId === userId && pending.timezone === timezone) return pending.report;
  const attempt = { userId, timezone, report: Promise.resolve() };
  // Replaced just below, before the attempt becomes visible as the pending one.
  attempt.report = reports.then(async () => {
    try {
      const me = await rpc("preferences/adoptTimezone", { timezone });
      // An answer holding a zone other than the one sent means the server kept a
      // hand-picked zone for the account; stay quiet while the server still holds it.
      if (typeof me.timezone === "string" && me.timezone !== timezone) {
        pinned = { userId, timezone: me.timezone };
      }
    } finally {
      if (pending === attempt) pending = null;
    }
  });
  reports = attempt.report.catch(() => {});
  pending = attempt;
  return attempt.report;
}
