import type { ModelCatalogEntry } from "@rakazo/contracts";
import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

export function providerHint(entry: ModelCatalogEntry) {
  if (entry.signIn === "device-code" || entry.signIn === "auth-url") {
    if (entry.provider === "openai-codex") return "ChatGPT Plus/Pro";
    if (entry.provider === "github-copilot") return "Copilot";
    if (entry.provider === "xai") return "SuperGrok / key";
    if (entry.provider === "anthropic") return "Claude Pro/Max / key";
    return "Sign in";
  }
  if (entry.auth === "oauth") return "Skip or deploy key";
  return "API key";
}

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
