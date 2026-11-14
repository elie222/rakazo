/** The device's IANA timezone (e.g. "Australia/Sydney") as the runtime reports it; UTC when it names none. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The runtime's own spelling of a zone, so aliases such as Asia/Kolkata and Asia/Calcutta match. */
function canonicalTimeZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/** Whether two zone names are the same zone, spellings aside; unset zones only match unset ones. */
export function sameTimeZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b;
  return a === b || canonicalTimeZone(a) === canonicalTimeZone(b);
}

/**
 * Whether a device owes the account its zone: the account follows its devices rather
 * than a hand-picked zone, and the server holds a zone other than the device's.
 */
export function timezoneReportDue(
  deviceZone: string,
  serverZone: string | null | undefined,
  serverSource: "device" | "manual" | null | undefined,
): boolean {
  return serverSource !== "manual" && !sameTimeZone(serverZone, deviceZone);
}
