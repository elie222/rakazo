import { canonicalPiProviderId } from "@rakazo/contracts";

/**
 * Catalog provider ids a deployment lets its users connect, read from the environment the
 * API and worker share. Entries are folded and canonicalized like stored provider ids, so
 * a name the registry renamed still matches. Unset or blank means every provider, exactly
 * the behavior without it.
 */
export function modelProviderAllowlist(): ReadonlySet<string> | null {
  const raw = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST?.trim();
  if (!raw) return null;
  const ids = new Set(
    raw
      .split(",")
      .map((id) => canonicalPiProviderId(id.trim().toLowerCase()))
      .filter((id) => id !== ""),
  );
  return ids.size > 0 ? ids : null;
}

/** Whether users may connect, run, or import this catalog provider on this deployment. */
export function modelProviderAllowed(
  allowlist: ReadonlySet<string> | null,
  provider: string,
): boolean {
  return allowlist === null || allowlist.has(canonicalPiProviderId(provider));
}

/** One refusal shared by every allowlist gate, so one setting reads as one rule. */
export const MODEL_PROVIDER_NOT_ALLOWED_ERROR =
  "This model provider is not allowed on this server.";
