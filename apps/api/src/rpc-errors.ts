import { ORPCError } from "@orpc/server";
import {
  SandboxAllowanceUsedError,
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import {
  IsolationError,
  ProviderTransactionBusyError,
  SpaceDeletionInProgressError,
  SpaceOwnerRequiredError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import { voiceAccountErrorStatus } from "./voice.js";

/**
 * Non-ORPCError failures are flattened into an opaque "Internal server error", so this log is
 * the only record of what broke. The cause chain matters: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function handleRpcError(
  error: unknown,
  path: readonly string[],
  signal?: AbortSignal,
): void {
  // A missing or foreign resource is the caller's mistake (a stale client, a deleted bot),
  // not a server failure, so it is a warning rather than an error report.
  if (error instanceof IsolationError) {
    getLogger().warn(`rpc ${path.join("/")} not found`, { "error.stack": error.stack });
    throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  if (error instanceof SpaceOwnerRequiredError) {
    throw new ORPCError("FORBIDDEN", { message: error.message, cause: error });
  }
  // A Space being deleted takes no new work; the caller learns it, nothing failed.
  if (error instanceof SpaceDeletionInProgressError) {
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // The user's own voice account refused the request: theirs to fix.
  if (error instanceof VoiceAccountError) {
    getLogger().warn(`rpc ${path.join("/")} voice provider account rejected the request`, {
      reason: error.code ?? error.message,
    });
    throw new ORPCError(error.code ?? "FORBIDDEN", {
      status: voiceAccountErrorStatus(error.code),
      message: error.message,
      cause: error,
    });
  }
  // The computer provider did not start the computer in time, or could not be reached: an outage
  // on its side the user can retry, not a server failure.
  if (error instanceof SandboxUnavailableError || error instanceof SandboxUnresponsiveError) {
    const unavailable =
      error instanceof SandboxUnavailableError
        ? error
        : new SandboxUnavailableError({ cause: error });
    getLogger().warn(`rpc ${path.join("/")} computer unavailable`, {
      reason: unavailable.cause instanceof Error ? unavailable.cause.message : undefined,
    });
    markExpectedFailure();
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: unavailable.message, cause: error });
  }
  // A provider kept another transaction busy past the wait; nothing failed, so the caller retries.
  if (error instanceof ProviderTransactionBusyError) {
    getLogger().warn(`rpc ${path.join("/")} provider transaction busy`);
    markExpectedFailure();
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message, cause: error });
  }
  if (error instanceof SandboxRateLimitError) {
    getLogger().warn(`rpc ${path.join("/")} computer rate limited`, {
      reason: error.cause instanceof Error ? error.cause.message : undefined,
    });
    throw new ORPCError("TOO_MANY_REQUESTS", { message: error.message, cause: error });
  }
  // The organization spent this period's computer allowance; its message says so.
  if (error instanceof SandboxAllowanceUsedError) {
    getLogger().warn(`rpc ${path.join("/")} computer allowance used up`);
    throw new ORPCError("FORBIDDEN", { message: error.message, cause: error });
  }
  // A retry cannot fix a damaged computer; its message tells the user to Recover it.
  if (error instanceof SandboxDamagedError) {
    getLogger().warn(`rpc ${path.join("/")} computer damaged`);
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // The client went away mid-request, so whatever failed next has no one waiting for it.
  if (signal?.aborted && !(error instanceof ORPCError)) {
    getLogger().warn(`rpc ${path.join("/")} client disconnected`, {
      reason: error instanceof Error ? error.message : String(error),
    });
    markExpectedFailure();
    return;
  }
  logUnexpectedRpcError(error, path);
}

export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  // A procedure's own 5xx (a store it depends on is down) would otherwise reach the collector
  // only as an anonymous failed request; report it under the procedure with its cause.
  if (error instanceof ORPCError && error.status < 500) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
