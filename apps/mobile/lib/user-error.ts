import {
  CONNECTOR_AUTH_UNAVAILABLE,
  isVoiceAccountErrorCode,
  MCP_OAUTH_CLIENT_REQUIRED,
} from "@rakazo/contracts";
import type { CredentialField } from "@rakazo/core";
import {
  authErrorMessage,
  isServerUnreachable,
  isUnreachableStatus,
  MAX_PASSWORD_LENGTH,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_IMAGE_INPUT_UNKNOWN,
  userErrorMessage,
} from "@rakazo/core";
import { t } from "./i18n";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(
  error: unknown,
  fallback = t("Something went wrong. Try again."),
): string {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_ERROR)
    return t("This model cannot read images. Choose a model that supports images.");
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_UNKNOWN)
    return t("Image input is not configured for this model.");
  if (errorCode(error) === CONNECTOR_AUTH_UNAVAILABLE)
    return t("This app needs its own sign-in setup to connect.");
  if (errorCode(error) === MCP_OAUTH_CLIENT_REQUIRED) return t("Needs an OAuth client ID");
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t("Could not reach the server") })
  );
}

/** Text for an error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = errorCode(error);
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t("Your voice provider is out of credit.")
    : t("Your voice provider key was rejected.");
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t("Enter a valid email") : t("Enter a password");
}

export function authErrorText(body: unknown, fallback: string): string {
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  if (code === "SSO_UNAVAILABLE") return t("SSO is temporarily unavailable. Try again.");
  if (code === "account_not_linked") return t("Sign in to your existing account to link SSO");
  if (code === "REGISTRATION_CLOSED") return t("Registration is closed");
  if (code === "EMAIL_NOT_ALLOWED") return t("Email is not allowed to register");
  if (code === "EMAIL_VERIFICATION_REQUIRED" || code === "unable_to_link_account")
    return t("Email verification required");
  if (code === "REAUTHENTICATION_REQUIRED") return t("Sign in again");
  if (code === "PASSWORD_AUTH_DISABLED") return t("Password sign-in is turned off on this server");
  if (code === "PASSWORD_TOO_LONG")
    return t("Password must be {max} characters or fewer", { max: MAX_PASSWORD_LENGTH });
  if (code === "EMAIL_DELETION_UNAVAILABLE") return t("Could not continue");
  if (code === "INVALID_OTP") return t("Invalid code");
  if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") return t("Request a new code");
  return authErrorMessage(body, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}

/** Status copy is a fallback: keep human server messages and known auth codes. */
export function authResponseErrorText(
  status: number,
  body: unknown,
  invalidJson = false,
  lastResort = t("Could not continue"),
): string {
  const fallback =
    status === 429
      ? t("Too many attempts. Try again in a few minutes.")
      : isUnreachableStatus(status)
        ? t("Could not reach the server")
        : status >= 500 || invalidJson
          ? t("The server had a problem. Try again in a moment.")
          : lastResort;
  return authErrorText(body, fallback).trim() || fallback;
}

/** Only implementation details from local session persistence need replacement. */
export function sessionSaveErrorText(error: unknown): string {
  return errorText(error, t("Could not save your sign-in on this device. Try again."));
}

export type LoadFailureKind = "offline" | "session" | "server" | "other";

/** Why a load failed, when the error says: no answer, a rejected session, or a server fault. */
export function loadFailureKind(error: unknown): LoadFailureKind {
  if (isServerUnreachable(error)) return "offline";
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  if (status === 401) return "session";
  if (typeof status === "number" && status >= 500) return "server";
  return "other";
}

/** Keep useful boot details; the screen supplies the recovery title and copy. */
export function computerBootErrorDetail(error: unknown): string | null {
  if (isServerUnreachable(error) || loadFailureKind(error) === "server") return null;
  const detail = errorText(error, "");
  return !detail ||
    /^(?:internal server error|server error|http\s+5\d{2}\b|5\d{2}\b)|time[ -]?out|timed out/i.test(
      detail,
    )
    ? null
    : detail;
}
