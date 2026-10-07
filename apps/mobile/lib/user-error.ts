import type { CredentialField } from "@rakazo/core";
import { authErrorMessage, userErrorMessage } from "@rakazo/core";
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
  return authErrorMessage(body, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}
