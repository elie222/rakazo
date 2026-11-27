import { randomBytes } from "node:crypto";

/** Long enough for the browser to start the download it was issued for. */
export const ACCOUNT_EXPORT_TOKEN_MS = 60_000;

/** Stored hashed (see `verification.storeIdentifier`), so the table never holds a usable token. */
export const ACCOUNT_EXPORT_TOKEN_PREFIX = "account-export-";

type Verification = { value: string; expiresAt: Date };

export async function issueAccountExportToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adapter.createVerificationValue({
    identifier: `${ACCOUNT_EXPORT_TOKEN_PREFIX}${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + ACCOUNT_EXPORT_TOKEN_MS),
  });
  return token;
}

/** The user the token was issued to, without spending it, so a failed download can be retried. */
export async function readAccountExportToken(
  adapter: { findVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const stored = await adapter.findVerificationValue(`${ACCOUNT_EXPORT_TOKEN_PREFIX}${token}`);
  return stored && stored.expiresAt.getTime() > Date.now() ? stored.value : null;
}

/**
 * Spends a link that a read already validated. The expiry was checked when the request started,
 * so a slow archive does not fail because it outlived its own link.
 */
export async function spendAccountExportToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const stored = await adapter.consumeVerificationValue(`${ACCOUNT_EXPORT_TOKEN_PREFIX}${token}`);
  return stored?.value ?? null;
}

/** The user the token was issued to, or null. Consuming is atomic, so a token works once. */
export async function consumeAccountExportToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const stored = await adapter.consumeVerificationValue(`${ACCOUNT_EXPORT_TOKEN_PREFIX}${token}`);
  return stored && stored.expiresAt.getTime() > Date.now() ? stored.value : null;
}
