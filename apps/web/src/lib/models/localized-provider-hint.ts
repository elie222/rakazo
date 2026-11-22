import { t } from "@lingui/core/macro";
import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Localize known provider auth hint fallbacks; pass through catalog `authHint` as-is. */
export function localizedProviderHint(entry: ModelCatalogEntry): string {
  if (entry.authHint) return entry.authHint;
  if (entry.signIn !== undefined) return t`Sign in`;
  if (entry.auth === "oauth") return t`Skip or deploy key`;
  return t`API key`;
}

/**
 * The provider-row subtitle, shown only when a provider is the exception:
 * sign-in, subscription, or custom-server auth. Plain API-key providers get none.
 */
export function providerRowHint(entry: ModelCatalogEntry): string | null {
  if (!entry.authHint && entry.signIn === undefined && entry.auth !== "oauth") return null;
  return localizedProviderHint(entry);
}
