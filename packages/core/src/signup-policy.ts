export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function emailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

export function signupsOpen(enabled: string | undefined): boolean {
  if (enabled === undefined) return true;
  return enabled !== "false" && enabled !== "0";
}

export function signupPolicyFromEnv(input: {
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
}): { enabled: boolean; allowlist: string[] } {
  return {
    enabled: signupsOpen(input.signupsEnabled),
    allowlist: parseAllowlist(input.signupAllowlist),
  };
}

/**
 * Non-empty SIGNUP_ALLOWLIST replaces the stored list on each API start.
 * A blank or unset value does not clear a stored list.
 * Uninitialized rows are copied separately so an upgrade still seeds both flags once.
 */
export function signupAllowlistBootUpdate(
  storedAllowlist: string,
  envAllowlist: string | undefined,
  policyInitialized: boolean,
): string | null {
  if (!policyInitialized) return null;
  const next = parseAllowlist(envAllowlist).join(",");
  if (!next) return null;
  if (next === parseAllowlist(storedAllowlist).join(",")) return null;
  return next;
}

/** How an allowlisted signup proceeds when delivery may be missing. */
export function allowlistedSignupAdmission(input: {
  allowlistSize: number;
  hasEmailDelivery: boolean;
  existingHumanCount: number;
}): "open" | "verify" | "needs-delivery" {
  if (input.allowlistSize === 0) return "open";
  if (input.hasEmailDelivery) return "verify";
  if (input.existingHumanCount === 0) return "open";
  return "needs-delivery";
}

/**
 * Decision after the deployment-settings row is locked. `claim` is the one
 * update that may set the owner; a concurrent signup loses that update.
 * Any other human account denies the exemption, verified or not, so an old
 * unverified signup cannot take the seat when delivery is later removed.
 */
export function firstAccountClaimDecision(input: {
  userId: string;
  ownerUserId: string | null;
  otherHuman: boolean;
}): "deny" | "claim" | "renew" {
  if (input.otherHuman) return "deny";
  if (input.ownerUserId && input.ownerUserId !== input.userId) return "deny";
  if (input.ownerUserId === input.userId) return "renew";
  return "claim";
}
