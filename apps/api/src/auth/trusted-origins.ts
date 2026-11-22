import { buildTrustedOrigins } from "@rakazo/auth";
import type { AppEnv } from "../env.js";

/**
 * Native clients always send the app scheme, including in Expo Go, so no
 * exp:// origin is trusted: it would accept any Expo host as a redirect target.
 * The loopback entries are the Expo web dev server.
 */
export const MOBILE_AUTH_ORIGINS = [
  "rakazo://",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

export function isTrustedOrigin(
  origin: string,
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl"> & { extraAuthOrigins?: string[] },
) {
  if (!origin) return true;
  if (origin.startsWith("rakazo://")) return true;
  return new Set(trustedRequestOrigins(env)).has(origin);
}

export function trustedRequestOrigins(
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl"> & { extraAuthOrigins?: string[] },
) {
  return buildTrustedOrigins({
    origins: [env.webOrigin, env.apiUrl, env.authUrl, ...MOBILE_AUTH_ORIGINS],
    // Exactly as configured, like Better Auth's extraOrigins: no loopback twins.
    extraOrigins: env.extraAuthOrigins,
    requestOrigins: true,
  });
}
