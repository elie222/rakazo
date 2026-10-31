import path from "node:path";
import { RAKAZO_CLOUD_URL } from "./setup-config.js";

/**
 * The only relying party a build is associated with (`webcredentials:` entitlement). The bundler
 * inlines `RAKAZO_PASSKEY_RP_ID`, so the app and its entitlements must be built with the same value.
 */
export const PASSKEY_RP_ID =
  process.env.RAKAZO_PASSKEY_RP_ID?.trim().toLowerCase() || new URL(RAKAZO_CLOUD_URL).hostname;

/**
 * Relying parties whose passkeys this build can use through the system passkey sheet. The
 * release workflow embeds a provisioning profile only together with the `webcredentials:`
 * entitlement, and macOS ignores that entitlement without one, so the profile is the signal.
 */
export function associatedPasskeyRpIds(input: {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  exists: (file: string) => boolean;
}): string[] {
  if (input.platform !== "darwin" || !input.packaged) return [];
  const profile = path.join(input.resourcesPath, "..", "embedded.provisionprofile");
  return input.exists(profile) ? [PASSKEY_RP_ID] : [];
}

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Adds the passkey association to the app's base entitlements for a build signed by `teamId`.
 * `developerMode` lets a development build fetch the association itself when Apple's CDN cannot
 * reach the domain; macOS only honors it for an app carrying `get-task-allow`.
 */
export function passkeyEntitlements(
  base: string,
  teamId: string,
  bundleId: string,
  options: { developerMode?: boolean } = {},
): string {
  if (!TEAM_ID.test(teamId))
    throw new Error("Apple Team ID must be 10 uppercase letters or digits");
  if (!BUNDLE_ID.test(bundleId)) throw new Error("Invalid bundle identifier");
  if (!DOMAIN.test(PASSKEY_RP_ID)) throw new Error("RAKAZO_PASSKEY_RP_ID must be a domain name");
  const end = base.lastIndexOf("</dict>");
  if (end === -1 || base.includes("com.apple.developer.associated-domains")) {
    throw new Error("Unexpected base entitlements");
  }
  const entries = [
    "    <!-- System passkeys (app.configureWebAuthn); requires the embedded provisioning profile. -->",
    "    <key>com.apple.application-identifier</key>",
    `    <string>${teamId}.${bundleId}</string>`,
    "    <key>com.apple.developer.associated-domains</key>",
    "    <array>",
    `      <string>webcredentials:${PASSKEY_RP_ID}${options.developerMode ? "?mode=developer" : ""}</string>`,
    "    </array>",
  ];
  if (options.developerMode) {
    entries.push("    <key>com.apple.security.get-task-allow</key>", "    <true/>");
  }
  return `${base.slice(0, end).trimEnd()}\n${entries.join("\n")}\n  ${base.slice(end)}`;
}
