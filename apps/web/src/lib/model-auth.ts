import type { ModelCatalogEntry } from "@rakazo/contracts";
import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./rpc";
import { uiCopy } from "./ui-copy";
import { localizeModelCopy } from "./ui-model-copy";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@rakazo/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

export function providerHint(entry: ModelCatalogEntry) {
  if (entry.authHint) return localizeModelCopy(entry.authHint);
  if (entry.signIn !== undefined) return uiCopy("Sign in");
  if (entry.auth === "oauth") return localizeModelCopy("Skip or deploy key");
  return uiCopy("API key");
}

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
