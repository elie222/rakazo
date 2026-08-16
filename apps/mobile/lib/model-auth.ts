import type { MobileModelCredential } from "./api";
import { rpc } from "./api";

type CompleteOAuthResult =
  | { status: "pending" }
  | { status: "connected"; credential: MobileModelCredential }
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

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  for (let i = 0; i < 180; i += 1) {
    throwIfAborted(signal);
    const result = await rpc<CompleteOAuthResult>("models/completeOAuth", { loginId });
    throwIfAborted(signal);
    if (result.status === "connected") return result;
    if (result.status === "error") throw new Error(result.error);
    await waitForNextPoll(signal);
  }
  throw new Error("Sign-in timed out. Try again.");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("OAuth polling cancelled");
}

function waitForNextPoll(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("OAuth polling cancelled"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 5000);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
