import { apiKey } from "@better-auth/api-key";
import type { BetterAuthPlugin } from "better-auth";

/** Marks a Rakazo key in logs and secret scanners. */
export const API_KEY_PREFIX = "rkz_";
export const API_KEY_NAME_MAX_LENGTH = 64;
/** Requests one key may make in a window; a key that runs out waits for the window to pass. */
export const API_KEY_RATE_LIMIT = { timeWindow: 60_000, maxRequests: 60 } as const;

/**
 * Keys for scripts and other agents. Only a hash is stored, and the key reaches no session:
 * the public API verifies it itself, so a key never opens the app's own procedures.
 */
export function apiKeys(): BetterAuthPlugin {
  return apiKey({
    defaultPrefix: API_KEY_PREFIX,
    requireName: true,
    maximumNameLength: API_KEY_NAME_MAX_LENGTH,
    enableSessionForAPIKeys: false,
    rateLimit: { enabled: true, ...API_KEY_RATE_LIMIT },
    schema: { apikey: { modelName: "apiKey" } },
  }) as unknown as BetterAuthPlugin;
}

export type VerifiedApiKey =
  | { ok: true; userId: string; keyId: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number };

type VerifyResult = {
  valid: boolean;
  error: { code?: string; details?: { tryAgainIn?: number } } | null;
  key: { id: string; referenceId: string } | null;
};

/** Reads `verifyApiKey`'s answer: an unknown, disabled or expired key is simply invalid. */
export function verifiedApiKey(result: VerifyResult): VerifiedApiKey {
  if (result.valid && result.key) {
    return { ok: true, userId: result.key.referenceId, keyId: result.key.id };
  }
  if (result.error?.code === "RATE_LIMITED") {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterMs: result.error.details?.tryAgainIn ?? API_KEY_RATE_LIMIT.timeWindow,
    };
  }
  return { ok: false, reason: "invalid" };
}
