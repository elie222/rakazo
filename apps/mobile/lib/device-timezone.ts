import type { Me } from "@rakazo/contracts";
import { localTimezone } from "@rakazo/core";
import { rpc } from "./api";

/** The report this device still owes: in flight, or queued behind an earlier one. */
let pending: { userId: string; timezone: string; report: Promise<void> } | null = null;

/** Reports are sent one at a time, so two answers cannot commit in reverse order. */
let reports: Promise<void> = Promise.resolve();

/**
 * Reports this device's zone for the account, which follows it until the user picks a
 * zone by hand; the server keeps that choice. The inbox load calls this with the zone
 * and its source from the same poll's `me`, and so does every foreground return, so a
 * zone the system changed while the app was away lands too. A report goes out only
 * while the account follows its devices and the server's zone differs from this
 * device's, so a write that lands late is caught by the next comparison, not by
 * memory. One report is in flight at a time: identical calls share it, a different
 * zone or account queues behind it.
 */
export function reportDeviceTimeZone(
  userId: string,
  serverZone: string | null | undefined,
  serverSource: Me["timezoneSource"],
): Promise<void> {
  const timezone = localTimezone();
  // A hand-picked zone stays; an older server cannot say, so the zone comparison rules.
  if (serverSource === "manual") return Promise.resolve();
  if (serverZone === timezone) return Promise.resolve();
  if (pending?.userId === userId && pending.timezone === timezone) return pending.report;
  const attempt = { userId, timezone, report: Promise.resolve() };
  // Replaced just below, before the attempt becomes visible as the pending one.
  attempt.report = reports.then(async () => {
    try {
      await rpc("preferences/adoptTimezone", { timezone });
    } finally {
      if (pending === attempt) pending = null;
    }
  });
  reports = attempt.report.catch(() => {});
  pending = attempt;
  return attempt.report;
}
