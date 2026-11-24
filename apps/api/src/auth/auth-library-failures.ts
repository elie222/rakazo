import { AsyncLocalStorage } from "node:async_hooks";
import { databaseOutage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  DATABASE_RETRY_AFTER_SECONDS,
  failedOnDatabaseOutage,
  requestHitDatabaseOutage,
} from "../rpc-errors.js";

type AuthLibraryFailure = { event: string; message: string; error?: Error };
const authLibraryFailures = new AsyncLocalStorage<AuthLibraryFailure[]>();

/**
 * The auth library logs a client's bad passkey or undeliverable address with the same call as its
 * own crashes, so a request holds them until its status says which they were.
 */
export function authLibraryLogger(event: string) {
  return {
    level: "error" as const,
    log: (_level: string, message: string, ...args: unknown[]) => {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      // The request answers 503, and the outage logs once for all of them.
      if (error && failedOnDatabaseOutage(error)) return;
      const failure = { event, message, error };
      const held = authLibraryFailures.getStore();
      if (held) held.push(failure);
      else logAuthLibraryFailure(failure, true);
    },
  };
}

/** Reports the auth library's failures only when the request answers 5xx, otherwise warns. */
export async function withAuthLibraryFailures(handle: () => Promise<Response>) {
  const failures: AuthLibraryFailure[] = [];
  let crashed = true;
  try {
    const response = await authLibraryFailures.run(failures, handle);
    crashed = response.status >= 500;
    // The library answers its own 500 when the database is down; ask the client to retry.
    if (response.status === 500 && requestHitDatabaseOutage())
      return new Response("Service Unavailable", {
        status: 503,
        headers: { "Retry-After": String(DATABASE_RETRY_AFTER_SECONDS) },
      });
    // An auth request that went through read the database, so any outage is over.
    if (response.status < 400 && !requestHitDatabaseOutage()) databaseOutage.succeeded();
    return response;
  } finally {
    for (const failure of failures) logAuthLibraryFailure(failure, crashed);
  }
}

function logAuthLibraryFailure({ event, message, error }: AuthLibraryFailure, crashed: boolean) {
  // Without an error, the library is echoing a failure it already logged with one.
  if (crashed)
    getLogger().error(event, error ?? { "error.report": false, "error.message": message });
  else getLogger().warn(event, { error, "error.message": message });
}

/**
 * Some clients POST auth actions with an empty body (older phone sign-out, the web deletion code);
 * Better Auth rejects that before the endpoint runs.
 */
export function emptyAuthBodyAsJson(request: Request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-length") !== "0" ||
    request.headers.has("transfer-encoding")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request, { headers, body: "{}" });
}
