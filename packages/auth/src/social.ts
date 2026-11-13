import type { SignInProvider } from "@rakazo/contracts";
import type { AppleProfile } from "better-auth/social-providers";
import { appleSigningKey } from "./apple-client-secret.js";
import { socialPresentation } from "./social-presentation.js";

interface AppleAccountLookup {
  account: {
    findFirst(args: {
      where: { providerId: "apple"; accountId: string };
      select: { user: { select: { email: true; emailVerified: true; name: true } } };
    }): Promise<{ user: { email: string; emailVerified: boolean; name: string } } | null>;
  };
}

export interface GoogleProviderConfig {
  id: "google";
  name: "Google";
  clientId: string;
  clientSecret: string;
}

export interface AppleProviderConfig {
  id: "apple";
  name: "Apple";
  /** Services ID. It is the OAuth client id and the subject of the client-secret JWT. */
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  /** iOS bundle id. When set, native identity tokens are accepted alongside the Services ID. */
  bundleId?: string;
}

export type BuiltinSocialProvider = GoogleProviderConfig | AppleProviderConfig;

export interface SocialAuthConfig {
  providers: BuiltinSocialProvider[];
}

export interface SocialAuthFields {
  googleClientId?: string;
  googleClientSecret?: string;
  appleClientId?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  appleBundleId?: string;
}

export interface PublicSignInProvider {
  presentation?: SignInProvider["presentation"];
  id: string;
  name: string;
  /** The server accepts a native identity token for this provider. */
  native?: true;
}

const GOOGLE_TOGETHER = "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together";
const APPLE_TOGETHER =
  "APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and an Apple private key must be configured together";

/** Enables each provider only when its credentials are complete. Anything partial refuses to start. */
export function socialAuthFromFields(fields: SocialAuthFields): SocialAuthConfig | undefined {
  const googleClientId = blank(fields.googleClientId);
  const googleClientSecret = blank(fields.googleClientSecret);
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error(GOOGLE_TOGETHER);
  const appleClientId = blank(fields.appleClientId);
  const teamId = blank(fields.appleTeamId);
  const keyId = blank(fields.appleKeyId);
  const privateKey = blank(fields.applePrivateKey);
  const appleParts = [appleClientId, teamId, keyId, privateKey];
  if (appleParts.some(Boolean) && !appleParts.every(Boolean)) throw new Error(APPLE_TOGETHER);
  const bundleId = blank(fields.appleBundleId);
  if (bundleId && !appleClientId) {
    throw new Error("APPLE_APP_BUNDLE_IDENTIFIER requires Apple sign-in");
  }
  for (const [label, value] of [
    ["GOOGLE_CLIENT_ID", googleClientId],
    ["APPLE_CLIENT_ID", appleClientId],
    ["APPLE_TEAM_ID", teamId],
    ["APPLE_KEY_ID", keyId],
    ["APPLE_APP_BUNDLE_IDENTIFIER", bundleId],
  ] as const) {
    if (value && /\s/.test(value)) throw new Error(`${label} must not contain spaces`);
  }
  if (privateKey) appleSigningKey(privateKey);

  const providers: BuiltinSocialProvider[] = [];
  if (googleClientId && googleClientSecret) {
    providers.push({
      id: "google",
      name: "Google",
      clientId: googleClientId,
      clientSecret: googleClientSecret,
    });
  }
  if (appleClientId && teamId && keyId && privateKey) {
    providers.push({
      id: "apple",
      name: "Apple",
      clientId: appleClientId,
      teamId,
      keyId,
      privateKey,
      ...(bundleId ? { bundleId } : {}),
    });
  }
  return providers.length ? { providers } : undefined;
}

/**
 * What the public capabilities endpoint may say. Names only: secrets stay on the server.
 * The deployment's own OpenID Connect provider leads, then each configured social provider.
 */
export function publicSignInProviders(
  social: SocialAuthConfig | undefined,
  oidc: { name: string } | undefined,
): PublicSignInProvider[] {
  const providers: PublicSignInProvider[] = [];
  if (oidc) providers.push({ id: "oidc", name: oidc.name });
  for (const provider of social?.providers ?? []) {
    providers.push({
      id: provider.id,
      name: provider.name,
      presentation: socialPresentation(provider.id),
      ...(provider.id === "apple" && provider.bundleId ? { native: true } : {}),
    });
  }
  return providers;
}

const AUTHORIZE: Record<string, { origin: string; pathname: string }> = {
  google: { origin: "https://accounts.google.com", pathname: "/o/oauth2/v2/auth" },
  apple: { origin: "https://appleid.apple.com", pathname: "/auth/authorize" },
};

/** The mobile authorization proxy may open only these endpoints, and only for enabled providers. */
export function isBuiltinAuthorizationURL(providerId: string, value: string): boolean {
  const expected = AUTHORIZE[providerId];
  if (!expected) return false;
  const url = URL.parse(value);
  return url?.origin === expected.origin && url.pathname === expected.pathname;
}

/** Only Apple's form POST callback needs the provider origin. OAuth state checks still apply. */
export function socialTrustedOrigins(
  social: SocialAuthConfig | undefined,
  request?: Request,
): string[] {
  return social?.providers.some((provider) => provider.id === "apple") &&
    request?.method === "POST" &&
    new URL(request.url).pathname === "/api/auth/callback/apple"
    ? ["https://appleid.apple.com"]
    : [];
}

/** Google is authoritative for Gmail and verified Workspace addresses, not third-party mailboxes. */
export function googleEmailVerified(profile: {
  email?: string;
  email_verified?: boolean;
  hd?: string;
}): boolean {
  return (
    profile.email_verified === true &&
    (profile.email?.toLowerCase().endsWith("@gmail.com") === true ||
      (typeof profile.hd === "string" &&
        profile.hd.length > 0 &&
        profile.email?.split("@")[1]?.toLowerCase() === profile.hd.toLowerCase()))
  );
}

/**
 * Better Auth links a verified email only for Apple, and only on the request that
 * finishes sign-in. Other providers, including generic OpenID Connect, keep implicit linking off.
 */
export function trustedSocialLinking(
  providerId: string | undefined,
): { enabled: true; disableImplicitLinking: false; trustedProviders: string[] } | undefined {
  // Google email_verified can be stale for mailboxes Google does not manage.
  if (providerId !== "apple") return undefined;
  return { enabled: true, disableImplicitLinking: false, trustedProviders: [providerId] };
}

export function requestProviderId(ctx: {
  path?: string;
  params?: Record<string, unknown>;
  body?: { provider?: unknown };
}): string | undefined {
  if (ctx.path === "/callback/:id" && typeof ctx.params?.id === "string") return ctx.params.id;
  if (
    (ctx.path === "/sign-in/social" || ctx.path === "/link-social") &&
    typeof ctx.body?.provider === "string"
  ) {
    return ctx.body.provider;
  }
  return undefined;
}

interface AppleIdentityToken {
  idToken?: string;
  user?: { name?: { firstName?: string; lastName?: string }; email?: string };
}

/**
 * Apple includes the email on the first authorization and often omits it later.
 * A returning account keeps the address already stored for that subject.
 */
export async function appleUserInfo(prisma: AppleAccountLookup, token: AppleIdentityToken) {
  if (!token.idToken) return null;
  const profile = jwtPayload(token.idToken);
  const subject = profile?.sub;
  if (!profile || typeof subject !== "string" || !subject.trim()) return null;
  const claimEmail = typeof profile.email === "string" ? profile.email.trim() : undefined;
  let email = claimEmail || undefined;
  let emailVerified = profile.email_verified === true || profile.email_verified === "true";
  let storedName = "";
  if (!email) {
    const account = await prisma.account.findFirst({
      where: { providerId: "apple", accountId: subject },
      select: { user: { select: { email: true, emailVerified: true, name: true } } },
    });
    if (account?.user.email) {
      email = account.user.email;
      emailVerified = account.user.emailVerified;
      storedName = account.user.name;
    }
  }
  const given = token.user?.name?.firstName?.trim() ?? "";
  const family = token.user?.name?.lastName?.trim() ?? "";
  const provided = `${given} ${family}`.trim();
  const profileName = typeof profile.name === "string" ? profile.name.trim() : "";
  return {
    user: { name: provided || profileName || storedName, email, emailVerified },
    // The decoded token is the provider profile. Cast keeps fields the library's
    // profile type requires even when Apple omits them on a later sign-in.
    data: {
      ...profile,
      sub: subject,
      email,
      name: provided || profileName || storedName,
      email_verified: emailVerified,
    } as AppleProfile,
  };
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
