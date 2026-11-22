import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { databaseOutage } from "@rakazo/db";
import { enrichLogContext } from "@rakazo/logging";
import type { Hono } from "hono";
import type { requestSessions } from "../auth/request-session.js";
import type { AppEnv } from "../env.js";
import type { createRouter } from "../router.js";
import {
  DATABASE_RETRY_AFTER_SECONDS,
  handleRpcError,
  requestHitDatabaseOutage,
} from "../rpc-errors.js";
import { clientBuildMiddleware, readDeployedWebBuild } from "./client-build.js";
import { rpcBodyLimit } from "./request-body-limit.js";

/** `/rpc/*`: every procedure, with the signed-in member it acts as. */
export function mountRpcRoute(
  app: Hono,
  router: ReturnType<typeof createRouter>,
  requestSession: ReturnType<typeof requestSessions>["requestSession"],
  env: Pick<AppEnv, "minimumClientBuilds" | "maxUploadSizeBytes">,
) {
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
  });
  app.use(
    "/rpc/*",
    clientBuildMiddleware({
      webBuild: readDeployedWebBuild(),
      minimums: env.minimumClientBuilds ?? {},
    }),
  );
  const limitRpcBody = rpcBodyLimit(env.maxUploadSizeBytes);
  app.use("/rpc/*", async (c, next) => {
    const session = await requestSession(c.req.raw);
    const actor = session?.actor ?? null;
    const tooLarge = await limitRpcBody(c, actor !== null);
    if (tooLarge) return tooLarge;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        sessionId: session?.sessionId,
        nativeSessionId:
          c.req.header("origin") === "rakazo://" &&
          c.req.header("authorization")?.startsWith("Bearer ")
            ? session?.sessionId
            : undefined,
        signal: c.req.raw.signal,
        // Same user in the same space, so leaving the space also ends a stream.
        // A database failure rejects this check; only a missing membership is unauthorized.
        stillAuthorized: async () => {
          const current = (await requestSession(c.req.raw, true))?.actor;
          return Boolean(
            actor && current?.userId === actor.userId && current.spaceId === actor.spaceId,
          );
        },
      },
    });
    if (!matched) return next();
    const reply = c.newResponse(response.body, response);
    if (requestHitDatabaseOutage())
      reply.headers.set("Retry-After", String(DATABASE_RETRY_AFTER_SECONDS));
    // A signed-in request that went through reached the database, so any outage is over.
    else if (actor && reply.status < 500) databaseOutage.succeeded();
    return reply;
  });
}
