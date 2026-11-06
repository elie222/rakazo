/** The device's IANA timezone (e.g. "Australia/Sydney") as the runtime reports it; UTC when it names none. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
