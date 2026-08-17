import { waitForModelOAuthCompletion } from "@rakazo/core";
import { rpc } from "./api";

export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";

type CompleteOAuthResult =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; error: string };

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(
    () => rpc<CompleteOAuthResult>("models/completeOAuth", { loginId }, { signal }),
    { signal },
  );
}
