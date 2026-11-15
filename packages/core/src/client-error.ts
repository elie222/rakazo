/** The HTTP-level kind of a refusal, named as its standard status is. */
export type ClientErrorKind =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS";

/**
 * A refusal the caller caused or can act on. The API answers it as `kind` with this message
 * instead of a server error, so the message is written for the person and a route lets the
 * error propagate rather than translating it.
 */
export class ClientError extends Error {
  /** What a client switches on: the kind, unless the refusal has a narrower stable code. */
  readonly code: string;

  constructor(
    readonly kind: ClientErrorKind,
    message: string,
    code: string = kind,
  ) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}
