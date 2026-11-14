/**
 * Why a private network refused. `credentials` and `permission` are the connection's setup and
 * need its admin; `destination` is the request; `unavailable` may pass on retry.
 */
export type PrivateNetworkErrorCode = "credentials" | "permission" | "destination" | "unavailable";

/** A private network refused or failed. The message is safe to show and never holds a secret. */
export class PrivateNetworkError extends Error {
  constructor(
    readonly code: PrivateNetworkErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PrivateNetworkError";
  }
}
