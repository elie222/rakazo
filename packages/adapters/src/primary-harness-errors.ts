/** Only fixed, documented error codes/statuses are interpreted; provider text is never displayed. */
export type NativeProviderFailure =
  | "authentication"
  | "quota"
  | "network"
  | "overloaded"
  | "model"
  | "context"
  | "request";
export function nativeProviderError(harness: string, code: NativeProviderFailure): Error {
  const message = {
    authentication: "could not authenticate this account. Reconnect it in connection settings.",
    quota: "reached this account's usage or rate limit. Check its quota or try again later.",
    network: "could not reach its provider. Check the endpoint and network, then retry.",
    overloaded: "provider is temporarily unavailable. Try again later.",
    model: "could not use the selected model. Check the profile's model and role mappings.",
    context: "reached its context limit. Start a new session or reduce the conversation input.",
    request: "provider rejected this request. Check the profile's protocol and supported inputs.",
  }[code];
  return new Error(`${harness} ${message}`);
}
export function nativeHttpFailure(status: unknown): NativeProviderFailure | undefined {
  if (status === 401 || status === 403) return "authentication";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504) return "network";
  if (typeof status === "number" && status >= 500 && status <= 599) return "overloaded";
  if (status === 400) return "request";
  if (status === 404) return "model";
  return undefined;
}
export function claudeProviderFailure(code: unknown): NativeProviderFailure | undefined {
  if (
    [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "verification_required",
      "cloud_credential_error",
    ].includes(String(code))
  )
    return "authentication";
  if (code === "billing_error" || code === "rate_limit") return "quota";
  if (code === "overloaded" || code === "server_error") return "overloaded";
  if (code === "model_not_found") return "model";
  if (code === "invalid_request") return "request";
  return undefined;
}
export function codexProviderFailure(error: unknown): NativeProviderFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const info = (error as Record<string, unknown>).codexErrorInfo;
  if (info === "unauthorized") return "authentication";
  if (
    info === "usageLimitExceeded" ||
    info === "rateLimitExceeded" ||
    info === "sessionBudgetExceeded"
  )
    return "quota";
  if (info === "contextWindowExceeded") return "context";
  if (info === "serverOverloaded" || info === "internalServerError") return "overloaded";
  if (info === "badRequest") return "request";
  if (info && typeof info === "object")
    for (const key of [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ]) {
      const detail = (info as Record<string, unknown>)[key];
      if (detail && typeof detail === "object")
        return nativeHttpFailure((detail as Record<string, unknown>).httpStatusCode) ?? "network";
    }
  return undefined;
}
export function kimiProviderFailure(code: unknown): NativeProviderFailure | undefined {
  if (
    [
      "auth.login_required",
      "auth.provisioning_required",
      "auth.token_missing",
      "auth.token_unauthorized",
      "provider.auth_error",
    ].includes(String(code))
  )
    return "authentication";
  if (code === "provider.rate_limit") return "quota";
  if (code === "provider.connection_error") return "network";
  if (code === "provider.overloaded") return "overloaded";
  if (
    [
      "model.not_configured",
      "model.config_invalid",
      "model.not_found",
      "auth.model_not_resolved",
    ].includes(String(code))
  )
    return "model";
  if (code === "context.overflow") return "context";
  return undefined;
}
