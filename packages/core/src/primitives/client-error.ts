/** The HTTP-level kind of an answer, named as its standard status is. */
export type ClientErrorKind =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE";

/**
 * A failure the caller is told about because they can act on it: a refusal they caused, a
 * session that ended (sign in again), or a dependency that is known to be down (try later).
 * The API answers it as `kind` with this message instead of an unexplained server error, so the
 * message is written for the person and a route lets the error propagate rather than
 * translating it. Throw it only where the condition is certain; a failure nobody can name
 * stays an ordinary error.
 */
export class ClientError extends Error {
  /** What a client switches on: the kind, unless the refusal has a narrower stable code. */
  readonly code: string;

  constructor(
    readonly kind: ClientErrorKind,
    message: string,
    code: string = kind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientError";
    this.code = code;
  }
}
