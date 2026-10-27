import type { ModelCredential } from "./domain.js";

/** Configured connections that can provide an upstream usage view. */
export function connectionUsageGroups(credentials: ModelCredential[]) {
  return credentials
    .filter((credential) => credential.hasKey || credential.authKind === "oauth")
    .map((credential) => ({ credential }));
}
