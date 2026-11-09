import { z } from "zod";

export const signInProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The server accepts a native identity token for this provider. */
  native: z.boolean().optional(),
});
export type SignInProvider = z.infer<typeof signInProviderSchema>;

export const authCapabilitiesSchema = z.object({
  sso: z
    .object({
      name: z.string().min(1),
      availability: z.enum(["available", "unavailable", "checking"]),
    })
    .nullable(),
  /**
   * Sign-in buttons. Older servers omit it; clients then show `sso` alone.
   * An empty list means this server configured none.
   */
  providers: z.array(signInProviderSchema).max(8).optional(),
  passwordAuth: z.boolean(),
  passwordReset: z.boolean(),
  resetUrl: z.string().url().nullable(),
  // Older servers omit this field; clients treat omission as unavailable.
  emailCode: z.boolean().optional(),
  billing: z.boolean().optional(),
  /** WebAuthn relying party ID; null or omitted when this server does not offer passkeys. */
  passkeyRpId: z.string().min(1).nullable().optional(),
  /** Native apps this domain vouches for; omitted by older servers, which means none. */
  nativePasskeys: z.object({ ios: z.boolean(), android: z.boolean() }).optional(),
  /** Crisp chat on the paywall; null or omitted when the deployment offers none. */
  crispWebsiteId: z.string().min(1).nullable().optional(),
});
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;

/**
 * The buttons on sign-in. A server that lists `providers` wins, including an empty list.
 * Older servers only had `sso`.
 */
export function signInProviders(capabilities: {
  sso: { name: string } | null;
  providers?: SignInProvider[] | undefined;
}): SignInProvider[] {
  if (capabilities.providers) return capabilities.providers;
  return capabilities.sso ? [{ id: "oidc", name: capabilities.sso.name }] : [];
}

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
  emailDeletion: z.boolean(),
  sso: z.object({ name: z.string().min(1) }).nullable(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** Only a complete pre-SSO shape may opt into password-only compatibility. */
export const legacyAuthCapabilitiesSchema = authCapabilitiesSchema
  .omit({ sso: true, passwordAuth: true })
  .strict()
  .transform((value) => ({ ...value, passwordAuth: true, sso: null }));

/** Pre-SSO servers only had credential accounts and password-protected deletion. */
export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: null,
};

/**
 * The RPC error code for a sensitive action the session must confirm its
 * identity for first. Clients confirm, then retry the action once.
 */
export const IDENTITY_CONFIRMATION_REQUIRED = "IDENTITY_CONFIRMATION_REQUIRED";

export function isIdentityConfirmationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === IDENTITY_CONFIRMATION_REQUIRED
  );
}

/**
 * Runs an action that may need a recent identity confirmation. When the server asks for one,
 * `confirm` prompts; once confirmed, the action is retried a single time.
 * A dismissed prompt rethrows the server's error.
 */
export async function runWithIdentityConfirmation<T>(
  action: () => Promise<T>,
  confirm: () => Promise<boolean>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isIdentityConfirmationRequired(error) || !(await confirm())) throw error;
  }
  return action();
}
