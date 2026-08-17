import { abortableDelay } from "./async.js";

export type ModelOAuthCompletion<TCredential> =
  | { status: "pending" }
  | { status: "connected"; credential: TCredential }
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

export async function waitForModelOAuthCompletion<TCredential>(
  complete: () => Promise<ModelOAuthCompletion<TCredential>>,
  options: { signal?: AbortSignal; attempts?: number; pollIntervalMs?: number } = {},
): Promise<{ status: "connected"; credential: TCredential }> {
  const attempts = options.attempts ?? 180;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await complete();
    throwIfAborted(options.signal);
    if (result.status === "connected") return result;
    if (result.status === "error") throw new Error(result.error);
    if (attempt < attempts) await abortableDelay(pollIntervalMs, options.signal);
  }
  throw new Error("Sign-in timed out. Try again.");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("OAuth polling cancelled");
}
