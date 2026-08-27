export const DEV_AUTH_SECRET_PLACEHOLDER = "dev-secret-change-me-please-32chars";
export const DEV_ENCRYPTION_KEY_PLACEHOLDER = "dev-encryption-key";
export const DEV_SUPERVISOR_TOKEN_PLACEHOLDER = "dev-supervisor-token-change-me-32chars";
export const DEV_SCREEN_PROXY_SECRET_PLACEHOLDER = "dev-screen-proxy-secret-change-me-32chars";
export const EXAMPLE_SUPERVISOR_TOKEN_PLACEHOLDER =
  "replace-with-32-plus-character-supervisor-token";
export const EXAMPLE_SCREEN_PROXY_SECRET_PLACEHOLDER =
  "replace-with-32-plus-character-screen-proxy-secret";

const RUNTIME_SECRETS_ERROR =
  "Set BETTER_AUTH_SECRET and ENCRYPTION_KEY to long random strings before starting Rakazo outside local development or tests.";

const DEDICATED_SECRET_PLACEHOLDERS = new Set([
  DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
  DEV_SCREEN_PROXY_SECRET_PLACEHOLDER,
  EXAMPLE_SUPERVISOR_TOKEN_PLACEHOLDER,
  EXAMPLE_SCREEN_PROXY_SECRET_PLACEHOLDER,
]);

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

function resolveDedicatedSecret(
  env: NodeJS.ProcessEnv,
  options: {
    name: string;
    conflicts: string[];
    missingMessage: string;
    conflictMessage: string;
    developmentFallback?: string;
  },
): string {
  const value = env[options.name]?.trim();
  if (!value) {
    if (options.developmentFallback && isDevSecretAllowed(env)) {
      return options.developmentFallback;
    }
    throw new Error(options.missingMessage);
  }
  if (!isDevSecretAllowed(env) && DEDICATED_SECRET_PLACEHOLDERS.has(value)) {
    throw new Error(`Replace the ${options.name} placeholder with a dedicated random credential.`);
  }
  if (options.conflicts.some((name) => value === env[name])) {
    throw new Error(options.conflictMessage);
  }
  if (!isDevSecretAllowed(env) && value.length < 32) {
    throw new Error(`${options.name} must be at least 32 characters outside local tests.`);
  }
  return value;
}

export function resolveSupervisorToken(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDedicatedSecret(env, {
    name: "SANDBOX_SUPERVISOR_TOKEN",
    conflicts: ["BETTER_AUTH_SECRET", "SCREEN_PROXY_SECRET"],
    missingMessage: "Set SANDBOX_SUPERVISOR_TOKEN to a dedicated random supervisor credential.",
    conflictMessage:
      "SANDBOX_SUPERVISOR_TOKEN must differ from BETTER_AUTH_SECRET and SCREEN_PROXY_SECRET.",
    developmentFallback: DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
  });
}

export function resolveScreenProxySecret(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDedicatedSecret(env, {
    name: "SCREEN_PROXY_SECRET",
    conflicts: ["BETTER_AUTH_SECRET", "SANDBOX_SUPERVISOR_TOKEN"],
    missingMessage: "Set SCREEN_PROXY_SECRET to a dedicated random screen proxy credential.",
    conflictMessage:
      "SCREEN_PROXY_SECRET must differ from BETTER_AUTH_SECRET and SANDBOX_SUPERVISOR_TOKEN.",
    developmentFallback: DEV_SCREEN_PROXY_SECRET_PLACEHOLDER,
  });
}

/**
 * The updater sidecar holds the Docker socket, which is root-equivalent on the host. Its bearer
 * credential must therefore be independent from the cookie-signing and sandbox credentials: a
 * leak at one boundary must not unlock either of the others.
 */
export function resolveUpdaterToken(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDedicatedSecret(env, {
    name: "RAKAZO_UPDATER_TOKEN",
    conflicts: ["BETTER_AUTH_SECRET", "SANDBOX_SUPERVISOR_TOKEN", "SCREEN_PROXY_SECRET"],
    missingMessage: "Set RAKAZO_UPDATER_TOKEN to a dedicated random updater credential.",
    conflictMessage:
      "RAKAZO_UPDATER_TOKEN must differ from BETTER_AUTH_SECRET, SANDBOX_SUPERVISOR_TOKEN, and SCREEN_PROXY_SECRET.",
  });
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
