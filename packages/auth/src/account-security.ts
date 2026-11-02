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
import { parseCookies } from "better-auth/cookies";
import { bearer } from "better-auth/plugins";
import type { EmailLocaleOf } from "./email.js";
import { accountDeletionEmail } from "./email.js";
import { isCurrentOidcAccount } from "./oidc.js";

export const oidcProofKey = (sessionId: string) => `oidc-reauth-${sessionId}`;

export function accountSecurity(
  email: TransactionalEmailProvider | undefined,
  emailLocaleOf: EmailLocaleOf,
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
            ssoLinked: (
              await Promise.all(
                accounts.map((account) =>
                  isCurrentOidcAccount(account, ssoIssuer, ctx.context.secretConfig),
                ),
              )
            ).some(Boolean),
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
          const locale = await emailLocaleOf({ id: user.id }, ctx.headers);
          await email.send(await accountDeletionEmail(user.email, token, locale));
          return ctx.json({ success: true });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/delete-user" || ctx.path === "/delete-user/callback",
          handler: createAuthMiddleware(async (ctx) => {
            // Deletion codes are submitted through the CSRF-protected POST endpoint.
            // Never delete an account through a navigable GET callback.
            if (ctx.path === "/delete-user/callback") throw new APIError("FORBIDDEN");
            const session = await sessionForAuthHook(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            const credential = await ctx.context.internalAdapter.findCredentialAccount(
              session.user.id,
            );
            if (credential?.password) {
              if (!ctx.body?.password) {
                throw new APIError("BAD_REQUEST", {
                  message: "Invalid password",
                  code: "INVALID_PASSWORD",
                });
              }
              return;
            }
            // Better Auth consumes and validates email deletion tokens against this user.
            if (ctx.body?.token) return;
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

/**
 * Session rows hold the raw token, so a raw bearer could be replayed from a database
 * copy. A bearer must carry the signature the session cookie has.
 */
const bearerPlugin = bearer({ requireSignature: true });
const bearerHook = bearerPlugin.hooks.before[0]!;
export const signedBearer: typeof bearerPlugin = {
  ...bearerPlugin,
  hooks: {
    ...bearerPlugin.hooks,
    before: [
      {
        ...bearerHook,
        handler: createAuthMiddleware(async (ctx) => {
          if (!(ctx.request?.headers ?? ctx.headers)?.has("authorization")) return;
          // Native credentials must never authorize browser accounts, including
          // the multi-session plugin's sign-out-all hook and cached session reads.
          const headers = new Headers(ctx.request?.headers ?? ctx.headers);
          const cookies = parseCookies(headers.get("cookie") ?? "");
          const names = Object.values(ctx.context.authCookies).map((cookie) => cookie.name);
          for (const key of cookies.keys()) {
            if (
              names.some(
                (name) =>
                  key === name || key.startsWith(`${name}_multi-`) || key.startsWith(`${name}.`),
              )
            ) {
              cookies.delete(key);
            }
          }
          headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
          const converted = await bearerHook.handler({
            ...ctx,
            headers,
            request: undefined,
            returnHeaders: false,
          });
          return { context: { headers: converted?.context.headers ?? headers } };
        }),
      },
    ],
  },
};

/** Hook results are applied after all before hooks, so native bearer conversion is explicit here. */
export async function sessionForAuthHook(ctx: Parameters<typeof getSessionFromCtx>[0]) {
  const converted = await signedBearer.hooks.before[0]!.handler({ ...ctx, returnHeaders: false });
  return getSessionFromCtx(
    { ...ctx, headers: converted?.context.headers ?? ctx.headers },
    { disableCookieCache: true },
  );
}
