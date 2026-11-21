import { MODEL_SIGN_IN_EXPIRED_ERROR } from "@rakazo/contracts";
import { pollUntil } from "../primitives/retry.js";
import { isRetryableError } from "../primitives/retry-policy.js";

export type ModelOAuthCompletion =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; error: string };

type OAuthControllerRef = { current: AbortController | null };

export function cancelModelOAuthAttempt(ref: OAuthControllerRef, reset: () => void) {
  const controller = ref.current;
  controller?.abort();
  if (ref.current !== controller) return;
  ref.current = null;
  reset();
}

export function finishModelOAuthAttempt(
  ref: OAuthControllerRef,
  controller: AbortController,
  resetBusy: () => void,
) {
  if (ref.current !== controller) return;
  ref.current = null;
  resetBusy();
}

/** The server reports an expired code itself; past this margin the client stops asking. */
const EXPIRY_GRACE_MS = 60_000;

export async function waitForModelOAuthCompletion(
  complete: () => Promise<ModelOAuthCompletion>,
  options: { expiresInSeconds: number; signal?: AbortSignal; pollIntervalMs?: number },
): Promise<{ status: "ready" }> {
  const { signal } = options;
  return pollUntil(
    async () => {
      throwIfAborted(signal);
      let result: ModelOAuthCompletion;
      try {
        result = await complete();
      } catch (error) {
        throwIfAborted(signal);
        if (!isRetryableError(error)) throw error;
        // A failed status read does not mean the sign-in itself failed.
        return undefined;
      }
      throwIfAborted(signal);
      if (result.status === "error") throw new Error(result.error);
      return result.status === "ready" ? result : undefined;
    },
    {
      intervalMs: options.pollIntervalMs ?? 5000,
      timeoutMs: options.expiresInSeconds * 1000 + EXPIRY_GRACE_MS,
      signal,
      onTimeout: () => {
        throw new Error(MODEL_SIGN_IN_EXPIRED_ERROR);
      },
    },
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("OAuth polling cancelled");
}
