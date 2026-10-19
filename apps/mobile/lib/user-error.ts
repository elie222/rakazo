import type { CredentialField } from "@rakazo/core";
import { authErrorMessage, isUnreachableStatus, userErrorMessage } from "@rakazo/core";
import { t } from "./i18n";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(
  error: unknown,
  fallback = t("Something went wrong. Try again."),
): string {
  return userErrorMessage(error, { fallback, offline: t("Could not reach the server") });
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t("Enter a valid email") : t("Enter a password");
}

/** Text for a failed auth response body. */
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
  if (code === "EMAIL_DELETION_UNAVAILABLE") return t("Could not continue");
  return authErrorMessage(body, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}

/** Status copy is a fallback: keep human server messages and known auth codes. */
export function authResponseErrorText(status: number, body: unknown, invalidJson = false): string {
  const fallback =
    status === 429
      ? t("Too many attempts. Try again in a few minutes.")
      : isUnreachableStatus(status)
        ? t("Could not reach the server")
        : status >= 500 || invalidJson
          ? t("The server had a problem. Try again in a moment.")
          : t("Could not continue");
  return authErrorText(body, fallback).trim() || fallback;
}

/** Only implementation details from local session persistence need replacement. */
export function sessionSaveErrorText(error: unknown): string {
  return errorText(error, t("Could not save your sign-in on this device. Try again."));
}
