import { t } from "@lingui/core/macro";
import { isServerUnreachable, isUnreachableStatus } from "@rakazo/core";
import { authErrorText, errorText } from "@rakazo/i18n/user-error";

export {
  authErrorText,
  credentialIssueText,
  errorText,
  voiceAccountErrorText,
} from "@rakazo/i18n/user-error";

/** Status copy is a fallback: keep human server messages and known auth codes. */
export function authResponseErrorText(
  status: number,
  body: unknown,
  invalidJson = false,
  lastResort = t`Could not continue`,
): string {
  const fallback =
    status === 429
      ? t`Too many attempts. Try again in a few minutes.`
      : isUnreachableStatus(status)
        ? t`Could not reach the server`
        : status >= 500 || invalidJson
          ? t`The server had a problem. Try again in a moment.`
          : lastResort;
  return authErrorText(body, fallback).trim() || fallback;
}

/** Only implementation details from local session persistence need replacement. */
export function sessionSaveErrorText(error: unknown): string {
  return errorText(error, t`Could not save your sign-in on this device. Try again.`);
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
