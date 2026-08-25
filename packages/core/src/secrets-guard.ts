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
 * The updater sidecar holds the Docker socket, which is root-equivalent on the host. Its bearer
 * credential must therefore be independent from the cookie-signing and sandbox credentials: a
 * leak at one boundary must not unlock either of the others.
 */
export function resolveUpdaterToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.RAKAZO_UPDATER_TOKEN?.trim();
  if (!token) {
    throw new Error("Set RAKAZO_UPDATER_TOKEN to a dedicated random updater credential.");
  }
  if (token === env.BETTER_AUTH_SECRET || token === env.SANDBOX_SUPERVISOR_TOKEN) {
    throw new Error(
      "RAKAZO_UPDATER_TOKEN must differ from BETTER_AUTH_SECRET and SANDBOX_SUPERVISOR_TOKEN.",
    );
  }
  if (!isDevSecretAllowed(env) && token.length < 32) {
    throw new Error("RAKAZO_UPDATER_TOKEN must be at least 32 characters outside local tests.");
  }
  return token;
}

/**
 * Constant-time bearer comparison, shared by every privileged sidecar.
 *
 * Deliberately not `node:crypto`'s `timingSafeEqual`: this module is reachable from the web bundle
 * through `@rakazo/core`, and importing `node:crypto` here fails the production Vite build with
 * `"timingSafeEqual" is not exported by "__vite-browser-external"`, which takes the whole
 * application image down with it. The XOR accumulation below inspects every byte no matter where
 * the first difference falls, which is the property that mattered. Length is compared first, as it
 * was before — a length mismatch is already observable from the response.
 */
export function hasValidBearerToken(authorization: string | undefined, expectedToken: string) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const encoder = new TextEncoder();
  const actual = encoder.encode(expectedToken);
  const candidate = encoder.encode(supplied);
  if (actual.length !== candidate.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (candidate[index] ?? 0);
  }
  return difference === 0;
}
