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

export function sameTimeZone(a: string, b: string): boolean {
  return a === b || canonicalTimeZone(a) === canonicalTimeZone(b);
}

/** The place a zone is named after, for "Switch to Tokyo time?": "America/New_York" reads "New York". */
export function timeZonePlace(zone: string): string {
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

/**
 * What an app does about the device's zone: `adopt` it for an account that has none, `ask`
 * before moving an account set to another zone, or nothing. `kept` is the device zone the
 * user last chose to keep the account's zone for, so they are asked again only once the
 * device moves to yet another zone.
 */
export function deviceTimezoneStep(
  device: string,
  account: string | null,
  kept: string | null,
): "adopt" | "ask" | null {
  if (account === null) return "adopt";
  if (sameTimeZone(account, device)) return null;
  if (kept !== null && sameTimeZone(kept, device)) return null;
  return "ask";
}
