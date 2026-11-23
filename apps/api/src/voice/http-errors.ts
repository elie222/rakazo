import { ORPCError } from "@orpc/server";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { NoVoiceConfigured, VoiceProviderRefusedError } from "@rakazo/adapters";
import type { VoiceAccountErrorCode } from "@rakazo/contracts";
import { ConnectionSetupError } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { getLogContext, getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import type { Context } from "hono";
import { clientErrorStatus } from "../client-error-status.js";

/** Spent credit is 402; any other refusal is 403, never 401, which clients read as a lost session. */
export function voiceAccountErrorStatus(code: VoiceAccountErrorCode | undefined) {
  return code === "VOICE_OUT_OF_CREDIT" ? 402 : 403;
}

export function voiceHttpError(c: Context, error: unknown) {
  if (error instanceof IsolationError) {
    return c.json({ error: "Resource not found" }, 404);
  }
  if (error instanceof NoVoiceConfigured) {
    return c.json({ error: error.message }, 409);
  }
  if (error instanceof ClientError) {
    const status = clientErrorStatus(error.kind);
    // An outage the caller is told to wait out is still a failure to look at, unless its thrower
    // logged it as expected.
    if (status >= 500 && !getLogContext()["error.expected"]) {
      getLogger().error("voice request unavailable", {
        route: c.req.path,
        reason: error.cause instanceof Error ? error.cause.name : error.kind,
      });
    }
    return c.json(
      { error: error.message, ...(error.code !== error.kind ? { code: error.code } : {}) },
      status,
    );
  }
  if (error instanceof ORPCError) {
    const code = String(error.code ?? "BAD_REQUEST");
    const status =
      code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return c.json({ error: error.message }, status);
  }
  if (error instanceof VoiceAccountError) {
    getLogger().warn("voice provider account rejected the request", {
      route: c.req.path,
      reason: error.code ?? error.name,
    });
    return c.json({ error: error.message, code: error.code }, voiceAccountErrorStatus(error.code));
  }
  const message = "Voice request failed. Try again.";
  // Log only the error kind; provider response text can contain credentials.
  getLogger().warn("voice request failed", {
    route: c.req.path,
    reason: error instanceof Error ? error.name : "unknown",
    ...(error instanceof VoiceProviderRefusedError
      ? { "provider.status": error.status, "provider.reason": error.reason }
      : {}),
  });
  if (isVoiceProviderFailure(error)) markExpectedFailure();
  return c.json({ error: message }, 502);
}

/** Voice adapters raise plain errors for provider refusals and setup problems; anything else is a bug. */
export function isVoiceProviderFailure(error: unknown) {
  return (
    error instanceof Error &&
    (Object.getPrototypeOf(error) === Error.prototype ||
      error instanceof VoiceProviderRefusedError ||
      error instanceof ConnectionSetupError ||
      error.name === "AbortError" ||
      error.name === "TimeoutError")
  );
}
