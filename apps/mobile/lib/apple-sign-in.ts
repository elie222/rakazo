import { t } from "@lingui/core/macro";
import { signInWithIdentityToken } from "./api-auth";
import { continueWithSso } from "./sso";

/** Native sign-in for a provider that asked for it. Anything else uses the browser. */
export function continueWithNativeSignIn(providerId: string): Promise<boolean> {
  if (providerId === "apple") return continueWithApple();
  return continueWithSso("sign-in", providerId);
}

/**
 * The system Sign in with Apple sheet. A binary without the native module, or a
 * device where it is unavailable, uses the same browser session as other providers.
 */
export async function continueWithApple(): Promise<boolean> {
  try {
    const apple = await import("expo-apple-authentication");
    if (!(await apple.isAvailableAsync())) return continueWithSso("sign-in", "apple");
    const credential = await apple.signInAsync({
      requestedScopes: [
        apple.AppleAuthenticationScope.FULL_NAME,
        apple.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error(t`Could not continue`);
    const given = credential.fullName?.givenName ?? undefined;
    const family = credential.fullName?.familyName ?? undefined;
    await signInWithIdentityToken(
      "apple",
      credential.identityToken,
      given || family || credential.email
        ? {
            name: given || family ? { firstName: given, lastName: family } : undefined,
            email: credential.email ?? undefined,
          }
        : undefined,
    );
    return true;
  } catch (error) {
    if (appleCancelled(error)) return false;
    throw error;
  }
}

function appleCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_REQUEST_CANCELED"
  );
}
