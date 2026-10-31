import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import type { ProductAnalytics, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import {
  displayName,
  emailAllowed,
  isMessagingEmail,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  signupPolicyFromEnv,
} from "@rakazo/core";
import type { PrismaClient, SecurityEventType } from "@rakazo/db";
import { bootstrapUserSpace, personalOrganizationIds, recordSecurityEvent } from "@rakazo/db";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
} from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { emailOTP, organization } from "better-auth/plugins";
import {
  ACCOUNT_EXPORT_TOKEN_PREFIX,
  consumeAccountExportToken,
  issueAccountExportToken,
} from "./account-export-token.js";
import {
  accountSecurity,
  oidcProofKey,
  sessionForAuthHook,
  signedBearer,
} from "./account-security.js";
import { breachedPasswordCheck } from "./breached-password.js";
import { passwordResetEmail, signInCodeEmail, verificationEmail } from "./email.js";
import { hasRecentIdentityConfirmation, identityConfirmation } from "./identity-confirmation.js";
import type { OidcConfig } from "./oidc.js";
import { isCurrentOidcAccount, oidcDiscovery } from "./oidc.js";
import { passkeyRelyingParty } from "./passkey.js";
import type { TokenKey } from "./token-storage.js";
import { encryptStoredOAuthTokens, openIdToken, sealIdToken } from "./token-storage.js";

export { passwordResetEmail, signInCodeEmail, verificationEmail } from "./email.js";
export type { OidcConfig } from "./oidc.js";
export { passkeyRelyingParty } from "./passkey.js";
export {
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
export { referralEmail } from "./referral-email.js";
export { welcomeEmail } from "./welcome-email.js";

export interface AuthEnv {
  analytics?: ProductAnalytics;
  passwordAuth?: boolean;
  /** Opt-in: rejects new passwords found in Have I Been Pwned. Calls an outside service. */
  breachedPasswordCheck?: boolean;
  oidc?: OidcConfig;
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  /** SHA-256 signing certificate fingerprints of Android apps allowed to use this server's passkeys. */
  androidAppCertFingerprints?: string[];
  email?: TransactionalEmailProvider;
  logger?: BetterAuthOptions["logger"];
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** Runs when a session row is deleted. Delivery also drops a token whose session is missing or expired. */
  afterDeleteSession?: (session: AuthSession) => Promise<void>;
  /** Runs when a password change replaces the caller's own session instead of ending it. */
  afterReplaceSession?: (previous: AuthSession, session: AuthSession) => Promise<void>;
  afterSignIn?: (userId: string) => Promise<void>;
}

type AuthSession = { id: string; userId: string };

const SEND_SIGN_IN_CODE_PATH = "/email-otp/send-verification-otp";
const CODE_SIGN_IN_PATH = "/sign-in/email-otp";

const CREDENTIAL_PATHS = [
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  SEND_SIGN_IN_CODE_PATH,
  CODE_SIGN_IN_PATH,
] as const;

/** Sign-in codes are short-lived, single use and hashed at rest. */
export const SIGN_IN_CODE_EXPIRES_IN_SECONDS = 10 * 60;

/**
 * The email OTP plugin also exposes OTP email verification, password reset and
 * email change. Rakazo uses links for those, so only sign-in codes stay open.
 */
function isUnusedEmailCodePath(path: string, body: { type?: unknown } | undefined): boolean {
  if (path === SEND_SIGN_IN_CODE_PATH) return body?.type !== "sign-in";
  return path.startsWith("/email-otp/") || path === "/forget-password/email-otp";
}

/**
 * The only header Better Auth reads a client IP from. The API sets it from the socket peer and its
 * trusted proxies and drops any client-supplied copy, so a caller cannot choose its own address.
 */
export const CLIENT_IP_HEADER = "x-rakazo-client-ip";

/** Routes that end sessions other than the caller's own sign-out. Recorded per deleted session. */
const REVOCATION_PATHS = new Set(["/revoke-session", "/revoke-sessions", "/revoke-other-sessions"]);

/** Successful account changes worth an audit row. Sign-in, sign-up, sign-out and deletion use hooks. */
const ACCOUNT_EVENT_PATHS: Record<string, SecurityEventType> = {
  "/change-password": "auth.password.changed",
  "/set-password": "auth.password.changed",
  "/passkey/verify-registration": "auth.passkey.added",
  "/passkey/update-passkey": "auth.passkey.changed",
  "/passkey/delete-passkey": "auth.passkey.removed",
};

/** Shared across API processes. Off outside production so tests can sign in freely. */
export function authRateLimitOptions(nodeEnv = process.env.NODE_ENV) {
  const rule = { window: 15 * 60, max: 10 };
  return {
    enabled: nodeEnv === "production",
    storage: "database" as const,
    customRules: {
      ...Object.fromEntries(CREDENTIAL_PATHS.map((path) => [path, rule])),
      "/request-account-deletion": { window: 600, max: 3 },
      "/request-identity-code": { window: 600, max: 3 },
      "/confirm-identity": rule,
      "/passkey/verify-authentication": rule,
      "/passkey/verify-registration": rule,
      // Sign-in pages request a challenge on load for passkey autofill.
      "/passkey/generate-authenticate-options": { window: 60, max: 30 },
    },
  };
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  if (env.passwordAuth === false && !env.oidc)
    throw new Error("Password auth requires OIDC when disabled");
  const discovery = env.oidc ? oidcDiscovery(env.oidc) : undefined;
  // SSO-only deployments keep every email credential closed, codes included.
  const emailCodeSignIn = Boolean(env.email) && env.passwordAuth !== false;
  // SSO-only deployments keep the identity provider as the only way in.
  const relyingParty =
    env.passwordAuth === false
      ? null
      : passkeyRelyingParty(env.webOrigin, env.androidAppCertFingerprints);
  // Better Auth's own token key, so every stored token shares one cipher and key.
  let authContext: Promise<{ secretConfig: TokenKey }> | undefined;
  const tokenKey = async () => (await authContext!).secretConfig;
  const auth = betterAuth({
    appName: "Rakazo",
    logger: env.logger,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [...buildTrustedOrigins(env), "rakazo://"],
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true, trustedProviders: [] },
      encryptOAuthTokens: true,
    },
    // Store only a hash of identifiers that carry an emailed token. Other
    // identifiers hold no secret and stay readable.
    verification: {
      storeIdentifier: {
        default: "plain",
        overrides: {
          "reset-password:": "hashed",
          "delete-account-": "hashed",
          [ACCOUNT_EXPORT_TOKEN_PREFIX]: "hashed",
        },
      },
    },
    rateLimit: authRateLimitOptions(),
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: env.passwordAuth !== false,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }) => {
        await recordSecurityEvent({
          type: "auth.password.changed",
          userId: user.id,
          metadata: { via: "/reset-password" },
        });
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(await passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      // Open signups get a session at once; the link only marks the address verified.
      sendOnSignUp: Boolean(env.email),
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(await verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.method !== "oauth" || source.oauth?.providerId !== "oidc") return;
        const expectedUser = (await getOAuthState())?.serverContext?.reauthUserId;
        if (typeof expectedUser === "string" && user.id !== expectedUser)
          return { error: "REAUTHENTICATION_REQUIRED" };
        const verified = user.emailVerified === true;
        const email = String(user.email ?? "").toLowerCase();
        if (isMessagingEmail(email)) return { error: "EMAIL_NOT_AVAILABLE" };
        if (source.action === "link-account") {
          if (!verified) return { error: "unable_to_link_account" };
          return;
        }
        if (source.action === "create-user") {
          const policy = signupPolicyFromEnv(env);
          if (!policy.enabled) return { error: "REGISTRATION_CLOSED" };
          if (!env.oidc?.allowSignupBypass && !emailAllowed(email, policy.allowlist))
            return { error: "EMAIL_NOT_ALLOWED" };
          if (!env.oidc?.allowSignupBypass && policy.allowlist.length > 0 && !verified)
            return { error: "EMAIL_VERIFICATION_REQUIRED" };
          return;
        }
        if (source.action === "sign-in" && user.id) {
          const collision = await ctx.context.internalAdapter.findUserByEmail(email);
          if (collision && collision.user.id !== user.id) return { error: "account_not_linked" };
          const stored = await ctx.context.internalAdapter.findUserById(user.id);
          const credential = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (credential?.password && stored?.email.toLowerCase() !== email)
            return { error: "email_does_not_match" };
          // A previous verified claim must not mask a later false/missing claim.
          await ctx.context.internalAdapter.updateUser(user.id, { email, emailVerified: verified });
        }
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const organizationIds = await personalOrganizationIds(prisma, user.id);

          await prisma.$transaction(async (tx) => {
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            await tx.messagingIdentity.deleteMany({
              where: { userId: user.id },
            });
            await tx.passkey.deleteMany({ where: { userId: user.id } });
            await tx.organization.deleteMany({
              where: { id: { in: organizationIds } },
            });
          });
        },
        afterDelete: async (user) => {
          await recordSecurityEvent({ type: "auth.account.deleted", userId: user.id });
        },
      },
    },
    plugins: [
      signedBearer,
      expo(),
      accountSecurity(env.email, env.oidc?.name, env.oidc?.issuer, env.passwordAuth !== false),
      identityConfirmation(env.email),
      ...(discovery ? [discovery.plugin] : []),
      ...(emailCodeSignIn
        ? [
            emailOTP({
              otpLength: 6,
              expiresIn: SIGN_IN_CODE_EXPIRES_IN_SECONDS,
              allowedAttempts: 3,
              storeOTP: "hashed",
              sendVerificationOTP: async ({ email, otp }) => {
                // Like password reset, do not wait on delivery: a refused address
                // answers at once, so waiting would reveal which addresses are admitted.
                void env.email
                  ?.send(await signInCodeEmail(email, otp))
                  .catch((error) => env.onEmailError?.(error));
              },
            }),
          ]
        : []),
      ...(env.breachedPasswordCheck ? [breachedPasswordCheck()] : []),
      // Registration keeps the plugin default: a fresh session of the signed-in user.
      // Sign-in creates its session through the session hooks below like every other method.
      ...(relyingParty
        ? [
            passkey({
              rpID: relyingParty.rpID,
              rpName: "Rakazo",
              origin: relyingParty.origins,
            }) as BetterAuthPlugin,
          ]
        : []),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-in/social" &&
          ctx.body?.provider === "oidc" &&
          ctx.body?.additionalData?.reauthenticate === true
        ) {
          const session = await sessionForAuthHook(ctx);
          if (!session || isMessagingEmail(session.user.email)) throw new APIError("UNAUTHORIZED");
          const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
          const current = await Promise.all(
            accounts.map((account) =>
              isCurrentOidcAccount(account, env.oidc?.issuer, ctx.context.secretConfig),
            ),
          );
          const accountIds = accounts
            .filter((_, index) => current[index])
            .map((account) => account.accountId);
          if (!accountIds.length || ctx.body.idToken) throw new APIError("FORBIDDEN");
          await addOAuthServerContext({
            reauthUserId: session.user.id,
            reauthSessionToken: session.session.token,
            reauthAccountIds: accountIds,
            reauthStartedAt: Math.floor(Date.now() / 1_000),
          });
        }
        if (
          ctx.path === "/expo-authorization-proxy" &&
          !(await discovery?.isAuthorizationURL(String(ctx.query?.authorizationURL ?? "")))
        ) {
          throw new APIError("BAD_REQUEST", { message: "Invalid authorizationURL" });
        }
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        if (
          env.passwordAuth === false &&
          [...CREDENTIAL_PATHS, "/reset-password", "/change-password", "/set-password"].includes(
            ctx.path,
          )
        ) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_AUTH_DISABLED",
            message: "Password authentication is disabled",
          });
        }
        if (isUnusedEmailCodePath(ctx.path, ctx.body)) throw new APIError("NOT_FOUND");
        if (ctx.path === SEND_SIGN_IN_CODE_PATH || ctx.path === CODE_SIGN_IN_PATH) {
          // A code for an unknown address creates an account, so it passes the
          // same registration policy as password signup. A refused address is
          // answered like any other so replies do not reveal which accounts exist.
          const email = String(ctx.body?.email ?? "")
            .trim()
            .toLowerCase();
          if (!(await ctx.context.internalAdapter.findUserByEmail(email))) {
            const admission = signupPolicyFromEnv(env);
            if (!admission.enabled || !emailAllowed(email, admission.allowlist)) {
              if (ctx.path === SEND_SIGN_IN_CODE_PATH) return ctx.json({ success: true });
              throw new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: "Invalid OTP" });
            }
          }
        }
        let policy =
          ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email"
            ? signupPolicyFromEnv(env)
            : undefined;
        let requireEmailVerification = false;
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw new APIError("BAD_REQUEST", {
              code: "REGISTRATION_CLOSED",
              message: "Registration is closed",
            });
          }
          const email = String(ctx.body?.email ?? "");
          if (!emailAllowed(email, policy.allowlist)) {
            throw new APIError("BAD_REQUEST", {
              code: "EMAIL_NOT_ALLOWED",
              message: "Email is not allowed to register",
            });
          }
          if (policy.allowlist.length > 0 && !env.email) {
            throw new APIError("BAD_REQUEST", {
              message: "Registration requires email delivery",
            });
          }
          requireEmailVerification = policy.allowlist.length > 0;
        } else if (policy) {
          requireEmailVerification = policy.allowlist.length > 0;
        }
        const { findSession, updateUser } = ctx.context.internalAdapter;
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy
                ? {
                    options: {
                      emailAndPassword: { requireEmailVerification },
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Better Auth drops an unverified account's logins and sessions when a
                // code proves the mailbox; credentials Rakazo stores elsewhere go too.
                ...(ctx.path === CODE_SIGN_IN_PATH
                  ? {
                      updateUser: async (...args: Parameters<typeof updateUser>) => {
                        if (args[1].emailVerified === true)
                          await revokeUnprovenCredentials(prisma, args[0]);
                        return updateUser(...args);
                      },
                    }
                  : {}),
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.emailVerified) return session;
                  if (env.oidc?.allowSignupBypass) {
                    const accounts = await ctx.context.internalAdapter.findAccounts(
                      session.user.id,
                    );
                    if (accounts.some((account) => account.providerId === "oidc")) return session;
                  }
                  policy ??= signupPolicyFromEnv(env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        const accountEvent = ACCOUNT_EVENT_PATHS[ctx.path];
        if (accountEvent && !(ctx.context.returned instanceof APIError)) {
          await recordSecurityEvent({
            type: accountEvent,
            userId: ctx.context.session?.user.id,
            metadata: { via: ctx.path },
          });
        }
        const returned = ctx.context.returned;
        // These routes fall back to the stored ID token, which is sealed at rest.
        if (
          (ctx.path === "/get-access-token" || ctx.path === "/refresh-token") &&
          isRecord(returned) &&
          typeof returned.idToken === "string"
        ) {
          const idToken = await openIdToken(ctx.context.secretConfig, returned.idToken);
          return ctx.json({ ...returned, idToken: idToken ?? undefined });
        }
        const redacted = withoutSessionTokens(ctx.path, returned);
        if (redacted) return ctx.json(redacted);
        const signed = withSignedSessionToken(ctx.context, returned);
        if (signed) return ctx.json(signed);
      }),
    },
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, idToken: await sealIdToken(await tokenKey(), account.idToken) },
          }),
        },
        update: {
          before: async (account) =>
            account.idToken === undefined
              ? undefined
              : {
                  data: {
                    ...account,
                    idToken: await sealIdToken(await tokenKey(), account.idToken),
                  },
                },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = signupPolicyFromEnv(env);
            const oidcSignIn = isOidcCallback(ctx);
            const bypassAllowlist = oidcSignIn && env.oidc?.allowSignupBypass;
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_VERIFICATION_REQUIRED",
                message: "Email verification required",
              });
            }
            if (!user.emailVerified && policy.allowlist.length > 0 && !bypassAllowlist) {
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_VERIFICATION_REQUIRED",
                message: "Email verification required",
              });
            }
            // Only admitted sessions provision a workspace; never assign administration.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              if (
                !policy.enabled ||
                (!bypassAllowlist && !emailAllowed(user.email, policy.allowlist))
              ) {
                throw new APIError("FORBIDDEN", {
                  code: "REGISTRATION_CLOSED",
                  message: "Registration is closed",
                });
              }
              await bootstrapUserSpace(prisma, user, env);
            }
          },
          after: async (session, ctx) => {
            await env.afterSignIn?.(session.userId);
            env.analytics?.capture(
              session.userId,
              { name: "signed_in" },
              { id: session.id, at: session.createdAt },
            );
            if (!replacedSession(ctx)) {
              await recordSecurityEvent({
                type: "auth.sign_in",
                userId: session.userId,
                ip: session.ipAddress,
                userAgent: session.userAgent,
                metadata: { via: ctx?.path ?? null },
              });
            }
            const context =
              ctx && isOidcCallback(ctx) ? (await getOAuthState())?.serverContext : undefined;
            // Set only after ID-token verification and exact linked-account binding.
            if (
              ctx &&
              context?.reauthUserId === session.userId &&
              typeof context.reauthExpiresAt === "number" &&
              context.reauthExpiresAt > Date.now()
            ) {
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: oidcProofKey(session.id),
                value: session.userId,
                expiresAt: new Date(context.reauthExpiresAt),
              });
              await recordSecurityEvent({
                type: "auth.identity.confirmed",
                userId: session.userId,
                metadata: { method: "sso" },
              });
            }
            const previous = replacedSession(ctx);
            if (previous) await env.afterReplaceSession?.(previous, session);
          },
        },
        delete: {
          after: async (session, ctx) => {
            if (ctx?.path === "/sign-out") {
              await recordSecurityEvent({ type: "auth.sign_out", userId: session.userId });
            } else if (ctx?.path && REVOCATION_PATHS.has(ctx.path)) {
              await recordSecurityEvent({
                type: "auth.session.revoked",
                userId: session.userId,
                metadata: { via: ctx.path },
              });
            }
            if (replacedSession(ctx)?.id !== session.id) await env.afterDeleteSession?.(session);
          },
        },
      },
      user: {
        create: {
          after: async (user, ctx) => {
            env.analytics?.capture(
              user.id,
              { name: "account_created" },
              { id: user.id, at: user.createdAt },
            );
            await recordSecurityEvent({
              type: "auth.sign_up",
              userId: user.id,
              metadata: { via: ctx?.path ?? null },
            });
          },
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            return {
              data: {
                ...user,
                ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}),
              },
            };
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
            return {
              data: {
                ...user,
                ...(user.name !== undefined ? { name: displayName(user.name, "") } : {}),
              },
            };
          },
        },
      },
    },
  });
  authContext = auth.$context;
  return Object.assign(auth, {
    emailCodeSignIn,
    /** Encrypts OAuth tokens stored before encryption was enabled. Safe to rerun. */
    encryptStoredOAuthTokens: async () => encryptStoredOAuthTokens(prisma, await tokenKey()),
    ssoAvailability: () => discovery?.availability(),
    passkeyRpId: relyingParty?.rpID ?? null,
    hasRecentIdentityConfirmation: async (session: { sessionId: string; userId: string }) =>
      hasRecentIdentityConfirmation((await auth.$context).internalAdapter, session),
    issueAccountExportToken: async (userId: string) =>
      issueAccountExportToken((await auth.$context).internalAdapter, userId),
    consumeAccountExportToken: async (token: string) =>
      consumeAccountExportToken((await auth.$context).internalAdapter, token),
    disposeOidcDiscovery: () => discovery?.dispose(),
  });
}

export type Auth = ReturnType<typeof createAuth>;

async function revokeUnprovenCredentials(prisma: PrismaClient, userId: string) {
  await prisma.$transaction([
    prisma.passkey.deleteMany({ where: { userId } }),
    prisma.messagingIdentity.deleteMany({ where: { userId } }),
    prisma.messagingLinkCode.deleteMany({ where: { userId } }),
    prisma.userDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

/**
 * Changing the password with revokeOtherSessions deletes every session, then signs the
 * caller in again, so the caller's device stays signed in under a new session.
 */
function replacedSession(
  ctx: { path?: string; context: { session?: { session: AuthSession } | null } } | null,
): AuthSession | undefined {
  return ctx?.path === "/change-password" ? ctx.context.session?.session : undefined;
}

/**
 * A session token is a bearer credential. Session reads describe sessions
 * without handing any of them out; sign-in and sign-up still return the token
 * they just issued. Returns the redacted body, or undefined to keep it.
 */
function withoutSessionTokens(
  path: string,
  returned: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (path === "/list-sessions" && Array.isArray(returned)) {
    return returned.map(withoutToken);
  }
  if (
    (path === "/get-session" || path === "/update-session") &&
    isRecord(returned) &&
    isRecord(returned.session)
  ) {
    return { ...returned, session: withoutToken(returned.session) };
  }
  return undefined;
}

/**
 * A sign-in body carries the new session's raw token, which the bearer plugin
 * refuses. Swap in the signed value from the session cookie, so a native client
 * that keeps the body token stores a bearer that works.
 */
function withSignedSessionToken(
  context: {
    newSession: { session: { token: string } } | null;
    responseHeaders?: Headers;
    authCookies: { sessionToken: { name: string } };
  },
  returned: unknown,
): Record<string, unknown> | undefined {
  const token = context.newSession?.session.token;
  if (!token || !isRecord(returned)) return undefined;
  const cookie = parseSetCookieHeader(context.responseHeaders?.get("set-cookie") ?? "").get(
    context.authCookies.sessionToken.name,
  );
  if (!cookie?.value || cookie["max-age"] === 0) return undefined;
  const signed = decodeURIComponent(cookie.value);
  if (!signed.startsWith(`${token}.`)) return undefined;
  if (returned.token === token) return { ...returned, token: signed };
  if (isRecord(returned.session) && returned.session.token === token) {
    return { ...returned, session: { ...returned.session, token: signed } };
  }
  return undefined;
}

function withoutToken(session: unknown): unknown {
  if (!isRecord(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
export function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/**
 * Spaces are Better Auth organizations, but their lifecycle belongs to the
 * product RPCs. No client calls the organization plugin over HTTP, so every
 * route under it stays closed, including ones a future plugin version adds.
 */
export function isBlockedAuthPath(path: string): boolean {
  return path.startsWith("/organization");
}

function isOidcCallback(
  ctx: { path?: string; params?: Record<string, unknown> } | null | undefined,
): boolean {
  return ctx?.path === "/callback/:id" && ctx.params?.id === "oidc";
}
