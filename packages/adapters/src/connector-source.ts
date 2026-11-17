import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ConnectionSetupError } from "@rakazo/contracts";
import { sanitizeConnectorError } from "./connector-safety.js";
import { McpResponseTooLargeError } from "./mcp-response-limit.js";
import { sanitizeIntegrationError } from "./providers/integration/composio/composio-connector.js";
import {
  ConnectorRedirectError,
  RemoteRequestSentError,
  TLS_CERTIFICATE_CODES,
} from "./remote-mcp.js";

/** Socket, DNS and TLS failures reaching the host the person entered. */
const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  ...TLS_CERTIFICATE_CODES,
]);
const MAX_CAUSE_DEPTH = 5;

/**
 * Runs the check of a connector source against the person's server. What that server answered,
 * or not reaching it, is theirs to fix, so it reaches them as a setup error with the credential
 * redacted; anything else is our fault and propagates as it is.
 */
export async function checkConnectorSource<T>(
  check: () => Promise<T>,
  input: { credential?: string; signal?: AbortSignal },
): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (input.signal?.aborted || !isSourceFailure(error)) throw error;
    const secrets = input.credential ? [input.credential] : [];
    throw new ConnectionSetupError(
      sanitizeConnectorError(sanitizeIntegrationError(error), secrets),
      { cause: error },
    );
  }
}

function isSourceFailure(error: unknown): boolean {
  return (
    error instanceof ConnectionSetupError ||
    error instanceof ConnectorRedirectError ||
    error instanceof McpResponseTooLargeError ||
    error instanceof StreamableHTTPError ||
    error instanceof McpError ||
    error instanceof UnauthorizedError ||
    isUnreachableHost(error)
  );
}

/** The request never got an answer from the host: it could not be reached, failed TLS
 * verification, dropped the connection, or was too slow for the request's own deadline. */
export function isUnreachableHost(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || !(error instanceof Error)) return false;
  if (
    error instanceof RemoteRequestSentError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return true;
  const { code } = error as { code?: unknown };
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
  const inner = error instanceof AggregateError ? error.errors : [error.cause];
  return inner.some((cause) => isUnreachableHost(cause, depth + 1));
}
