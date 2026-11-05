import type { ApnsConfig } from "./apns-http.js";

/** The published desktop app's bundle id (apps/desktop/package.json); self-built apps set their own. */
const DEFAULT_BUNDLE_ID = "dev.rakazo.desktop";

export function apnsDesktopConfig(
  source: Record<string, string | undefined>,
): ApnsConfig | undefined {
  if (
    !source.APNS_DESKTOP_KEY_ID &&
    !source.APNS_DESKTOP_TEAM_ID &&
    !source.APNS_DESKTOP_PRIVATE_KEY
  )
    return undefined;
  if (
    !source.APNS_DESKTOP_KEY_ID ||
    !source.APNS_DESKTOP_TEAM_ID ||
    !source.APNS_DESKTOP_PRIVATE_KEY
  )
    throw new Error(
      "APNS_DESKTOP_KEY_ID, APNS_DESKTOP_TEAM_ID and APNS_DESKTOP_PRIVATE_KEY must be configured together.",
    );
  if (
    source.APNS_DESKTOP_ENVIRONMENT &&
    !["sandbox", "production"].includes(source.APNS_DESKTOP_ENVIRONMENT)
  )
    throw new Error("APNS_DESKTOP_ENVIRONMENT must be sandbox or production.");
  return {
    keyId: source.APNS_DESKTOP_KEY_ID,
    teamId: source.APNS_DESKTOP_TEAM_ID,
    privateKey: source.APNS_DESKTOP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    environment: source.APNS_DESKTOP_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    bundleId: source.APNS_DESKTOP_BUNDLE_ID || DEFAULT_BUNDLE_ID,
  };
}

export async function createApnsDesktopProvider(config: ApnsConfig | undefined) {
  if (!config) return undefined;
  const { ApnsDesktopProvider } = await import("./apns-desktop.js");
  return new ApnsDesktopProvider(config);
}
