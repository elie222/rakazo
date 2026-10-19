import { t } from "@lingui/core/macro";
import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Localize known provider auth hint fallbacks; pass through catalog `authHint` as-is. */
export function localizedProviderHint(entry: ModelCatalogEntry): string {
  if (entry.authHint) return entry.authHint;
  if (entry.signIn !== undefined) return t`Sign in`;
  if (entry.auth === "oauth") return t`Skip or deploy key`;
  return t`API key`;
}
