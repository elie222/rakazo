import { t } from "@lingui/core/macro";
import type { CredentialField } from "@rakazo/core";
import { authErrorMessage, userErrorMessage } from "@rakazo/core";

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  return userErrorMessage(error, { fallback, offline: t`Could not reach the server` });
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t`Enter a valid email` : t`Enter a password`;
}

/** Text for a failed Better Auth client result (`{ code, message }`). */
export function authErrorText(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "SSO_UNAVAILABLE") return t`SSO is temporarily unavailable. Try again.`;
  if (code === "account_not_linked") return t`Sign in to your existing account to link SSO`;
  if (code === "REGISTRATION_CLOSED") return t`Registration is closed`;
  if (code === "EMAIL_NOT_ALLOWED") return t`Email is not allowed to register`;
  if (code === "EMAIL_VERIFICATION_REQUIRED" || code === "unable_to_link_account")
    return t`Email verification required`;
  if (code === "REAUTHENTICATION_REQUIRED") return t`Sign in again`;
  if (code === "PASSWORD_AUTH_DISABLED" || code === "EMAIL_DELETION_UNAVAILABLE")
    return t`Could not continue`;
  return authErrorMessage(error, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}
