import { timingSafeEqual } from "node:crypto";

export const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";
export const DEV_ENCRYPTION_KEY_PLACEHOLDER = "dev-encryption-key";

const RUNTIME_SECRETS_ERROR =
  "Set BETTER_AUTH_SECRET and ENCRYPTION_KEY to long random strings before starting Rakazo outside local development or tests.";

export function isDevSecretAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RAKAZO_ALLOW_DEV_SECRETS === "1") return true;
  if (env.VITEST) return true;
  const nodeEnv = env.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.BETTER_AUTH_SECRET;
  if (!value) {
    if (isDevSecretAllowed(env)) return DEV_AUTH_SECRET_PLACEHOLDER;
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value === DEV_AUTH_SECRET_PLACEHOLDER) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  return value;
}

export function resolveEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ENCRYPTION_KEY;
  if (!value) {
    if (isDevSecretAllowed(env)) return DEV_ENCRYPTION_KEY_PLACEHOLDER;
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  if (!isDevSecretAllowed(env) && value === DEV_ENCRYPTION_KEY_PLACEHOLDER) {
    throw new Error(RUNTIME_SECRETS_ERROR);
  }
  return value;
}

export function resolveSupervisorToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.SANDBOX_SUPERVISOR_TOKEN;
  if (token) return token;
  return resolveAuthSecret(env);
}

/**
 * The updater sidecar holds the Docker socket and, unlike the sandbox supervisor, acts on a
 * user-supplied repository URL. It gets its own token so revoking update access does not mean
 * rebuilding sandboxing, while still needing no configuration in a default deployment.
 */
export function resolveUpdaterToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.RAKAZO_UPDATER_TOKEN;
  if (token) return token;
  return resolveAuthSecret(env);
}

/** Constant-time bearer comparison, shared by every privileged sidecar. */
export function hasValidBearerToken(authorization: string | undefined, expectedToken: string) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(expectedToken);
  const candidate = Buffer.from(supplied);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}
