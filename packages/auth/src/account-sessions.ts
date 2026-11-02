import { APIError, createAuthEndpoint } from "better-auth/api";
import {
  deleteSessionCookie,
  expireCookie,
  parseCookies,
  setSessionCookie,
} from "better-auth/cookies";

type SessionContext = Parameters<typeof setSessionCookie>[0];
export const MAX_SAVED_BROWSER_ACCOUNTS = 5;

/** Multi-session cookies remain HttpOnly; account selectors never carry bearer credentials. */
async function savedSessions(ctx: SessionContext) {
  const primary = ctx.context.authCookies.sessionToken.name;
  const cookies = parseCookies(ctx.headers?.get("cookie") ?? "");
  const keys = [...cookies.keys()].filter(
    (key) => key === primary || key.startsWith(`${primary}_multi-`),
  );
  const tokens = await Promise.all(keys.map((key) => ctx.getSignedCookie(key, ctx.context.secret)));
  const verified = tokens.filter(
    (token): token is string => typeof token === "string" && Boolean(token),
  );
  if (!verified.length) return [];
  const sessions = await ctx.context.internalAdapter.findSessions([...new Set(verified)], {
    onlyActiveSessions: true,
  });
  return sessions.filter((item) => item.session.expiresAt.getTime() > Date.now());
}

/** Keep the plugin's cookie bound explicit, and adopt a login made before multi-session. */
export async function requireSavedAccountCapacity(ctx: SessionContext, userId: string) {
  const sessions = await savedSessions(ctx);
  const users = new Set(sessions.map((item) => item.user.id));
  if (!users.has(userId) && users.size >= MAX_SAVED_BROWSER_ACCOUNTS) {
    throw new APIError("FORBIDDEN", {
      code: "SAVED_ACCOUNT_LIMIT",
      message: "Sign out of an account before adding another",
    });
  }
  const primary = ctx.context.authCookies.sessionToken;
  const cookies = parseCookies(ctx.headers?.get("cookie") ?? "");
  const active = await ctx.getSignedCookie(primary.name, ctx.context.secret);
  const valid = new Set(sessions.map((item) => item.session.token));
  for (const name of [...cookies.keys()]) {
    if (!name.startsWith(`${primary.name}_multi-`)) continue;
    const token = await ctx.getSignedCookie(name, ctx.context.secret);
    if (typeof token === "string" && valid.has(token)) continue;
    cookies.delete(name);
    expireCookie(ctx, { name, attributes: primary.attributes });
  }
  // The first switch after upgrade must not lose the previously signed-in account.
  if (typeof active === "string" && valid.has(active)) {
    const name = `${primary.name}_multi-${active.toLowerCase()}`;
    if (!cookies.has(name)) {
      await ctx.setSignedCookie(name, active, ctx.context.secret, primary.attributes);
      cookies.set(name, cookies.get(primary.name)!);
    }
  }
  ctx.headers?.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
}

function requireTrustedOrigin(ctx: SessionContext) {
  const origin = ctx.headers?.get("origin");
  if (!origin || !ctx.context.isTrustedOrigin(origin)) throw new APIError("FORBIDDEN");
}

export function accountSessions() {
  return {
    id: "rakazo-account-sessions",
    endpoints: {
      listSavedAccounts: createAuthEndpoint(
        "/accounts/list",
        { method: "GET", requireHeaders: true },
        async (ctx) => {
          const sessions = await savedSessions(ctx);
          const users = new Set<string>();
          return ctx.json(
            sessions
              .filter((item) => {
                if (users.has(item.user.id)) return false;
                users.add(item.user.id);
                return true;
              })
              .map(({ session, user }) => ({
                userId: user.id,
                sessionId: session.id,
                name: user.name,
                email: user.email,
                image: user.image ?? null,
              })),
          );
        },
      ),
      selectSavedAccount: createAuthEndpoint(
        "/accounts/select",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          requireTrustedOrigin(ctx);
          const selected = (await savedSessions(ctx)).find(
            (item) => item.user.id === ctx.body?.userId,
          );
          if (!selected) throw new APIError("UNAUTHORIZED");
          await setSessionCookie(ctx, selected);
          return ctx.json({ userId: selected.user.id });
        },
      ),
      removeSavedAccount: createAuthEndpoint(
        "/accounts/remove",
        { method: "POST", requireHeaders: true },
        async (ctx) => {
          requireTrustedOrigin(ctx);
          const sessions = await savedSessions(ctx);
          const removed = sessions.filter((item) => item.user.id === ctx.body?.userId);
          if (!removed.length) throw new APIError("UNAUTHORIZED");
          const primary = ctx.context.authCookies.sessionToken;
          const active = await ctx.getSignedCookie(primary.name, ctx.context.secret);
          for (const item of removed) {
            await ctx.context.internalAdapter.deleteSession(item.session.token);
            expireCookie(ctx, {
              name: `${primary.name}_multi-${item.session.token.toLowerCase()}`,
              attributes: primary.attributes,
            });
          }
          if (removed.some((item) => item.session.token === active)) {
            const next = sessions.find((item) => item.user.id !== ctx.body?.userId);
            if (next) await setSessionCookie(ctx, next);
            else deleteSessionCookie(ctx);
          }
          return ctx.json({ ok: true });
        },
      ),
    },
  };
}
