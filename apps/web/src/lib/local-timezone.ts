/**
 * The browser's IANA timezone (e.g. "Australia/Sydney"), for timestamp inputs
 * that would otherwise default to UTC. Falls back to UTC when unavailable.
 */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
