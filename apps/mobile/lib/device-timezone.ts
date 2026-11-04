import { rpc } from "./api";

/** The device's IANA timezone as the runtime reports it; UTC when it names none. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The account and zone this launch already reported, so polls and foreground returns stay quiet. */
let reported: { userId: string; timezone: string } | null = null;

/**
 * Reports this device's zone for the account, which follows it until the user picks a
 * zone by hand; the server keeps that choice. Called on the inbox load and whenever the
 * app returns to the foreground, so a zone the system changed while it was away lands
 * too. Quiet unless the zone moved since the last report of this launch; a failed report
 * waits for the next zone change or launch.
 */
export async function reportDeviceTimeZone(userId: string): Promise<void> {
  const timezone = deviceTimeZone();
  if (reported?.userId === userId && reported.timezone === timezone) return;
  reported = { userId, timezone };
  await rpc("preferences/adoptTimezone", { timezone });
}
