import type { ApnsConfig } from "./apns-http.js";
import { apnsVoipConfig } from "./apns-voip-config.js";

/** The published desktop app's bundle id (apps/desktop/package.json); self-built apps set their own. */
const DEFAULT_BUNDLE_ID = "dev.rakazo.desktop";

/**
 * APNs auth keys are team-wide, so desktop pushes sign with the iOS app's key and differ only in
 * topic and in environment (a Developer ID build is production while a phone build may not be).
 */
export function apnsDesktopConfig(
  source: Record<string, string | undefined>,
): ApnsConfig | undefined {
  const key = apnsVoipConfig(source);
  if (!key) return undefined;
  const environment = source.APNS_DESKTOP_ENVIRONMENT;
  if (environment && !["sandbox", "production"].includes(environment))
    throw new Error("APNS_DESKTOP_ENVIRONMENT must be sandbox or production.");
  return {
    ...key,
    environment: environment === "sandbox" ? "sandbox" : "production",
    bundleId: source.APNS_DESKTOP_BUNDLE_ID || DEFAULT_BUNDLE_ID,
  };
}

export async function createApnsDesktopProvider(config: ApnsConfig | undefined) {
  if (!config) return undefined;
  const { ApnsDesktopProvider } = await import("./apns-desktop.js");
  return new ApnsDesktopProvider(config);
}
