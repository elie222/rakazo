import type { ModelAccountErrorCode, ModelAccountStatus } from "@rakazo/contracts";
import {
  modelAccountBalanceSchema,
  modelAccountConfigSchema,
  modelAccountConnectSchema,
  modelAccountErrorCodeSchema,
  modelAccountStatusSchema,
} from "@rakazo/contracts";
import { readBoundedJsonResponse } from "../primitives/http-response.js";

export class ModelAccountClientError extends Error {
  constructor(readonly code: ModelAccountErrorCode) {
    super("Model account request failed");
  }
}

export function createModelAccountClient(
  fetchImpl: typeof fetch = fetch,
  base = "/api/model-account",
) {
  const request = async (path: string, method = "GET", signal?: AbortSignal, body?: unknown) => {
    const timeout = AbortSignal.timeout(method === "GET" ? 8_000 : 40_000);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/${path}`, {
        method,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new ModelAccountClientError(method === "POST" ? "result_unknown" : "unavailable");
    }
    const value = await readBoundedJsonResponse<unknown>(response, 64 * 1024, signal).catch(() => {
      throw new ModelAccountClientError(method === "POST" ? "result_unknown" : "unavailable");
    });
    if (!response.ok) {
      const code = modelAccountErrorCodeSchema.safeParse(
        value && typeof value === "object" && "error" in value ? value.error : undefined,
      );
      throw new ModelAccountClientError(code.success ? code.data : "unavailable");
    }
    return value;
  };
  return {
    config: async (signal?: AbortSignal) =>
      modelAccountConfigSchema.parse(await request("config", "GET", signal)),
    status: async (signal?: AbortSignal) => {
      const status = modelAccountStatusSchema.parse(await request("status", "GET", signal));
      if (status.linked === false || status.recovery !== "authorization_unknown") return status;
      try {
        await request("recover", "POST", signal);
        return modelAccountStatusSchema.parse(await request("status", "GET", signal));
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ModelAccountClientError && error.code === "authorization_required")
          return { ...status, recovery: "authorization_required" as const };
        return status;
      }
    },
    balance: async (signal?: AbortSignal) =>
      modelAccountBalanceSchema.parse(await request("balance", "GET", signal)),
    connect: async (callbackURL?: string, signal?: AbortSignal) =>
      modelAccountConnectSchema.parse(await request("connect", "POST", signal, { callbackURL })),
    refreshModels: async (signal?: AbortSignal) => {
      await request("models", "POST", signal);
    },
    settings: async (apiProtocol: "chat-completions" | "responses", signal?: AbortSignal) => {
      await request("settings", "POST", signal, { apiProtocol });
    },
    revoke: async (signal?: AbortSignal) =>
      modelAccountStatusSchema
        .pick({ connected: true })
        .parse(await request("revoke", "POST", signal)),
  };
}

/** A missing connection or unfinished authorization needs a direct user action. */
export function modelAccountAuthorizationReason(status: ModelAccountStatus | undefined) {
  if (!status) return null;
  return status.recovery ?? (status.connected ? null : "authorization_required");
}
