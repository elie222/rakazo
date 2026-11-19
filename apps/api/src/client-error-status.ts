import type { ClientErrorKind } from "@rakazo/core";

const STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
} as const satisfies Record<ClientErrorKind, number>;

/** The HTTP status a client error's kind is answered with, on RPC and plain HTTP routes alike. */
export function clientErrorStatus(kind: ClientErrorKind) {
  return STATUS[kind];
}
