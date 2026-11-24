import type { Auth } from "@rakazo/auth";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, requireMembership } from "@rakazo/db";
import { enrichLogContext } from "@rakazo/logging";
import type { MiddlewareHandler } from "hono";

/**
 * No membership is no actor, which the RPC layer answers as 401. A database
 * failure, including the deployment-settings lookup, must stay a server error
 * so a blip does not look like a rejected session.
 */
export async function actorFromMembership(membership: Promise<Actor>): Promise<Actor | null> {
  try {
    return await membership;
  } catch (error) {
    if (error instanceof IsolationError) return null;
    throw error;
  }
}

/** Who sent a request: its session, and the member it acts as in the Space it names. */
export function requestSessions({ auth, prisma }: { auth: Auth; prisma: PrismaClient }) {
  // Reading a session here can renew it. The browser must get the renewed cookie too,
  // or it keeps the one from sign-in and is signed out when that one expires.
  const renewedSessionCookies = new WeakMap<Request, string[]>();
  const readSession = async (request: Request, disableRefresh = false) => {
    const { headers, response } = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
      query: { disableRefresh },
    });
    // A native client signs in with a bearer token and keeps no cookie.
    const incomingCookieNames = new Set(
      (request.headers.get("cookie") ?? "").split(";").map((cookie) => cookie.trim().split("=")[0]),
    );
    const cookies = headers
      .getSetCookie()
      .filter((cookie) => incomingCookieNames.has(cookie.split("=")[0]));
    if (cookies.length > 0) renewedSessionCookies.set(request, cookies);
    return response;
  };
  const sendRenewedCookies: MiddlewareHandler = async (c, next) => {
    const request = c.req.raw;
    await next();
    for (const cookie of renewedSessionCookies.get(request) ??
      renewedSessionCookies.get(c.req.raw) ??
      []) {
      c.header("set-cookie", cookie, { append: true });
    }
  };
  const requestSession = async (request: Request, disableRefresh = false) => {
    // The bearer plugin turns a signed `Authorization: Bearer` into the session cookie.
    const session = await readSession(request, disableRefresh);
    if (!session?.user) return null;
    const actor = await actorFromMembership(
      requireMembership(
        prisma,
        session.user,
        request.headers.get("x-rakazo-space-id"),
        session.session,
      ),
    );
    return actor && { actor, sessionId: session.session.id };
  };
  /** The signed-in member, added to the request's log context; null answers 401. */
  const sessionActor = async (request: Request) => {
    const actor = (await requestSession(request))?.actor ?? null;
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  };
  return { readSession, sendRenewedCookies, requestSession, sessionActor };
}
