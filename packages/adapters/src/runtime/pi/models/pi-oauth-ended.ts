import type {
  AnalyticsModelSignInEndReason,
  AnalyticsModelSignInErrorClass,
} from "@rakazo/contracts";

/** Kept with a sign-in whose steps are measured: the app it began in and which try it is. */
export type PiOAuthMeasure = { surface?: string; attempt: number };

/** A sign-in that gave the person a link or code and is waiting for them. */
export type PiOAuthPending = {
  userId: string;
  provider: string;
  mode: "device-code" | "auth-url";
  startedAt: Date;
  measure?: PiOAuthMeasure;
};

export type PiOAuthEnd = {
  reason: AnalyticsModelSignInEndReason;
  errorClass?: AnalyticsModelSignInErrorClass;
};

/** A sign-in that ended without connecting. Reported once, by the process that ended it. */
export type PiOAuthEnded = PiOAuthPending & PiOAuthEnd;

export const PENDING_SIGN_IN_COLUMNS = {
  id: true,
  userId: true,
  provider: true,
  ciphertext: true,
  surface: true,
  connectNumber: true,
  createdAt: true,
} as const;

type PendingSignInRow = {
  userId: string;
  provider: string;
  ciphertext: string | null;
  surface: string | null;
  connectNumber: number | null;
  createdAt: Date;
};

export function pendingSignInOfRow(row: PendingSignInRow): PiOAuthPending {
  return {
    userId: row.userId,
    provider: row.provider,
    // Only a sign-in that hands back a code stores what another process needs to exchange it.
    mode: row.ciphertext ? "auth-url" : "device-code",
    startedAt: row.createdAt,
    ...(row.connectNumber !== null
      ? {
          measure: { attempt: row.connectNumber, ...(row.surface ? { surface: row.surface } : {}) },
        }
      : {}),
  };
}

const HTTP_STATUS = /\((\d{3})\)|\bstatus (\d{3})\b|\bHTTP (\d{3})\b/i;

/**
 * Reduces the runtime's sign-in failure to a fixed reason and class. The message can quote
 * the provider's response, so it is read here and never leaves the adapter.
 */
export function signInFailure(message: string): PiOAuthEnd {
  if (/expired/i.test(message)) return { reason: "expired" };
  if (/timed out|timeout/i.test(message)) return { reason: "timed_out" };
  return { reason: "provider_refused", errorClass: refusalClass(message) };
}

function refusalClass(message: string): AnalyticsModelSignInErrorClass {
  if (/access_denied|denied|declined/i.test(message)) return "denied";
  if (/state mismatch|missing authorization code|invalid_grant|invalid code/i.test(message)) {
    return "invalid_code";
  }
  const match = HTTP_STATUS.exec(message);
  const status = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "rejected";
  return "other";
}
