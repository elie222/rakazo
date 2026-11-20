import type { OAuthCredential } from "@earendil-works/pi-ai";

export const OPENAI_AUTH_CLAIMS_NAMESPACE = "https://api.openai.com/auth";

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * `accountId`, else `chatgpt_account_id` from the access JWT. Never throws: an
 * undecodable token yields `undefined`, which disables the account-change
 * comparison instead of breaking refresh.
 */
export function oauthCredentialAccountId(credential: OAuthCredential): string | undefined {
  const direct = nonBlankString(credential.accountId);
  if (direct) return direct;
  const payload = decodeJwtPayload(credential.access);
  if (!payload) return undefined;
  const namespaced = payload[OPENAI_AUTH_CLAIMS_NAMESPACE];
  const claims =
    namespaced && typeof namespaced === "object"
      ? (namespaced as Record<string, unknown>)
      : undefined;
  return nonBlankString(claims?.chatgpt_account_id) ?? nonBlankString(payload.chatgpt_account_id);
}
