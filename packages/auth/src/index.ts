import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { emailAllowed, parseAllowlist, signupPolicyFromEnv } from "@rakazo/core";
import { bootstrapUserSpace, type PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer, genericOAuth, organization } from "better-auth/plugins";
import { type CompanyOsOAuthConfig, companyOsIdentity, companyOsSubject } from "./company-os.js";

export {
  companyOsIdentity,
  companyOsOAuthFromEnv,
  companyOsSubject,
  createCompanyOsCredential,
} from "./company-os.js";

export interface AuthEnv {
  companyOsOAuth?: CompanyOsOAuthConfig;
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
}

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupAllowlist: true, signupPolicyInitialized: true },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      enabled: settings.signupsEnabled,
      allowlist: parseAllowlist(settings.signupAllowlist),
    };
  }
  return signupPolicyFromEnv(env);
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: "Cadre",
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, allowDifferentEmails: false },
    },
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: !env.companyOsOAuth,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      ...(env.companyOsOAuth
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "company-os",
                  clientId: env.companyOsOAuth.clientId,
                  clientSecret: env.companyOsOAuth.clientSecret,
                  authorizationUrl: `${env.companyOsOAuth.origin}/oauth/authorize`,
                  tokenUrl: `${env.companyOsOAuth.origin}/api/oauth/token`,
                  issuer: env.companyOsOAuth.origin,
                  requireIssuerValidation: true,
                  pkce: true,
                  authentication: "post",
                  scopes: ["context:read", "context:write", "branch:create"],
                  authorizationUrlParams: { resource: `${env.companyOsOAuth.origin}/api/mcp` },
                  tokenUrlParams: { resource: `${env.companyOsOAuth.origin}/api/mcp` },
                  getUserInfo: async (tokens) => {
                    if (!tokens.accessToken) return null;
                    const identity = await companyOsIdentity(
                      env.companyOsOAuth!,
                      tokens.accessToken,
                    );
                    return {
                      id: companyOsSubject(env.companyOsOAuth!, identity.sub),
                      name: identity.name,
                      email: identity.email.toLowerCase(),
                      emailVerified: true,
                    };
                  },
                },
              ],
            }),
          ]
        : []),
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: async (ctx) => {
        const path = String((ctx as { path?: string }).path ?? "");
        if (env.companyOsOAuth && ctx.body && typeof ctx.body === "object") {
          for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"] as const) {
            const value = (ctx.body as Record<string, unknown>)[field];
            if (value === undefined) continue;
            let allowed = false;
            if (typeof value === "string" && !/[\\\r\n]/.test(value)) {
              try {
                const target = new URL(value, env.webOrigin);
                allowed =
                  target.origin === new URL(env.webOrigin).origin &&
                  /^\/(?:app(?:\/|$)|login$|sign-in$|onboarding$)/.test(target.pathname);
              } catch {
                /* Refuse malformed redirect targets. */
              }
            }
            if (!allowed)
              throw new APIError("FORBIDDEN", { message: "Invalid sign-in destination" });
          }
        }
        if (!path.includes("sign-up")) return;
        const policy = await resolveSignupPolicy(prisma, env);
        if (!policy.enabled) {
          throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
        }
        const email =
          typeof ctx.body === "object" && ctx.body && "email" in ctx.body
            ? String((ctx.body as { email?: string }).email ?? "")
            : "";
        if (email && !emailAllowed(email, policy.allowlist)) {
          throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (
              env.companyOsOAuth &&
              (!user.emailVerified ||
                !emailAllowed(user.email, parseAllowlist(env.signupAllowlist)))
            ) {
              throw new APIError("FORBIDDEN", {
                message: "This account is not allowed to register",
              });
            }
            return { data: user };
          },
          after: async (user) => {
            await bootstrapUserSpace(prisma, user, env);
          },
        },
      },
    },
  });
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: "Reset your Rakazo password",
    text: [
      `Hi ${name},`,
      "",
      "Reset your Rakazo password using this link:",
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your Rakazo password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
