import { t } from "@lingui/core/macro";
import { accountSecuritySchema, legacyAccountSecurity } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { authErrorText } from "./user-error";

export async function fetchAccountSecurity() {
  const response = await fetch("/api/auth/account-security", {
    signal: AbortSignal.timeout(8_000),
  });
  // Electron ships this client independently of the connected API version.
  if (response.status === 404) return legacyAccountSecurity;
  if (!response.ok) throw new Error(t`Could not load sign-in options`);
  try {
    return accountSecuritySchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024));
  } catch {
    throw new Error(t`Could not load sign-in options`);
  }
}

export async function requestAccountDeletionCode() {
  const response = await fetch("/api/auth/request-account-deletion", {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
    } catch {
      // Gateways may return HTML or an empty body.
    }
    throw new Error(authErrorText(body, t`Could not continue`));
  }
}
