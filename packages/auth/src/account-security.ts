import { randomBytes } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { isCurrentOidcAccount } from "./oidc.js";

export const OIDC_FRESH_AGE = 5 * 60;
export const oidcProofKey = (sessionId: string) => `oidc-reauth-${sessionId}`;

export function accountSecurity(
  email: TransactionalEmailProvider | undefined,
  ssoName?: string,
  ssoIssuer?: string,
  passwordChangeEnabled = true,
): BetterAuthPlugin {
  return {
    id: "account-security",
    endpoints: {
      accountSecurity: createAuthEndpoint(
        "/account-security",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const credential = await ctx.context.internalAdapter.findCredentialAccount(
            ctx.context.session.user.id,
          );
          const proof = await ctx.context.internalAdapter.findVerificationValue(
            oidcProofKey(ctx.context.session.session.id),
          );
          const accounts = await ctx.context.internalAdapter.findAccounts(
            ctx.context.session.user.id,
          );
          return ctx.json({
            freshOidcAuth: Boolean(
              proof &&
                proof.value === ctx.context.session.user.id &&
                proof.expiresAt.getTime() > Date.now(),
            ),
            ssoLinked: accounts.some((account) => isCurrentOidcAccount(account, ssoIssuer)),
            hasPassword: Boolean(credential?.password),
            passwordChangeEnabled,
            emailDeletion: Boolean(email),
            sso: ssoName ? { name: ssoName } : null,
          });
        },
      ),
      requestAccountDeletion: createAuthEndpoint(
        "/request-account-deletion",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user;
          if (
            !email ||
            (await ctx.context.internalAdapter.findCredentialAccount(user.id))?.password
          ) {
            throw new APIError("BAD_REQUEST", {
              message: "Email deletion is not available",
              code: "EMAIL_DELETION_UNAVAILABLE",
            });
          }
          const token = randomBytes(16).toString("hex");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `delete-account-${token}`,
            value: user.id,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
          await email.send({
            to: user.email,
            subject: "Confirm Rakazo account deletion",
            text: `Enter this code in Rakazo to delete your account:\n\n${token}\n\nThis code expires in ten minutes. If you did not request deletion, ignore this email.`,
            html: `<p>Enter this code in Rakazo to delete your account:</p><p>${token}</p><p>This code expires in ten minutes. If you did not request deletion, ignore this email.</p>`,
          });
          return ctx.json({ success: true });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/delete-user" || ctx.path === "/delete-user/callback",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await sessionForAuthHook(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            const credential = await ctx.context.internalAdapter.findCredentialAccount(
              session.user.id,
            );
            if (credential?.password) {
              if (ctx.path === "/delete-user/callback" || !ctx.body?.password) {
                throw new APIError("BAD_REQUEST", {
                  message: "Invalid password",
                  code: "INVALID_PASSWORD",
                });
              }
              return;
            }
            // Better Auth consumes and validates email deletion tokens against this user.
            if (ctx.body?.token || ctx.query?.token) return;
            const proof = await ctx.context.internalAdapter.findVerificationValue(
              oidcProofKey(session.session.id),
            );
            if (
              !proof ||
              proof.value !== session.user.id ||
              proof.expiresAt.getTime() <= Date.now()
            ) {
              throw new APIError("FORBIDDEN", {
                code: "REAUTHENTICATION_REQUIRED",
                message: "Sign in again or use an email code to delete your account",
              });
            }
          }),
        },
      ],
    },
  };
}

/** Hook results are applied after all before hooks, so native bearer conversion is explicit here. */
export async function sessionForAuthHook(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const converted = await bearer().hooks.before[0]!.handler({ ...ctx, returnHeaders: false });
  return getSessionFromCtx(
    { ...ctx, headers: converted?.context.headers ?? ctx.headers },
    { disableCookieCache: true },
  );
}
