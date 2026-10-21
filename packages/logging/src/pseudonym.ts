import { createHmac } from "node:crypto";

const MONITORING_USER_ID = /^[0-9a-f]{64}$/;

/**
 * The id error reports carry for a user: a keyed hash, so the collector can count affected users
 * without learning who they are. It is stable per secret, and distinct from the analytics id made
 * with the same secret, so the two collectors cannot join their records.
 */
export function monitoringUserId(secret: string, userId: string): string {
  return createHmac("sha256", secret).update(`monitoring-user:${userId}`).digest("hex");
}

/** Only a value shaped like `monitoringUserId` output may reach a collector as a user id. */
export function isMonitoringUserId(value: unknown): value is string {
  return typeof value === "string" && MONITORING_USER_ID.test(value);
}

/** Error reporting shares the analytics pseudonym secret; unset means reports carry no user. */
export function monitoringPseudonymSecret(source: NodeJS.ProcessEnv = process.env) {
  return source.ANALYTICS_PSEUDONYM_SECRET?.trim() || undefined;
}
