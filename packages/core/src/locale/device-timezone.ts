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

/**
 * The place a zone is named after, for "Switch to Tokyo time?": "America/New_York" reads
 * "New York". A fixed-offset zone reads as its offset, "GMT+9" for Etc/GMT-9, whose sign
 * is inverted.
 */
export function timeZonePlace(zone: string): string {
  if (zone.startsWith("Etc/")) {
    try {
      const offset = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "shortOffset",
      })
        .formatToParts(0)
        .find((part) => part.type === "timeZoneName")?.value;
      if (offset) return offset;
    } catch {
      // An unknown zone falls back to its name.
    }
  }
  return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

/** A "Keep" answer: the account zone the user kept while the device was in `device`. */
export type KeptTimezone = { device: string; account: string };

/**
 * What an app does about the device's zone: `adopt` it for an account that has none, `ask`
 * before moving an account set to another zone, or nothing. A Keep holds only for the device
 * zone and account zone it was given for, so the user is asked again once either changes.
 */
export function deviceTimezoneStep(
  device: string,
  account: string | null,
  kept: KeptTimezone | null,
): "adopt" | "ask" | null {
  if (account === null) return "adopt";
  if (sameTimeZone(account, device)) return null;
  if (kept && sameTimeZone(kept.device, device) && sameTimeZone(kept.account, account)) return null;
  return "ask";
}

/** A stored Keep, or null for anything else. */
export function parseKeptTimezone(value: unknown): KeptTimezone | null {
  if (!value || typeof value !== "object") return null;
  const { device, account } = value as Record<string, unknown>;
  return typeof device === "string" && typeof account === "string" ? { device, account } : null;
}
