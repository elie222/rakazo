import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@rakazo/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
