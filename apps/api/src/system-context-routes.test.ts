import { Hono } from "hono";
import { expect, it } from "vitest";
import { SYSTEM_CONTEXT_PATHS } from "./system-context-routes.js";
import { systemContextRoutes } from "./system-context-routes.test-support.js";

it("lists every route that can answer under a system-context path", () => {
  const app = new Hono();
  for (const [path] of SYSTEM_CONTEXT_PATHS) app.use(path, (_c, next) => next());
  app.use("*", (_c, next) => next());
  app.get("/api/v1/bots/:botId/avatar", (c) => c.body(null));
  app.post("/api/v1/messaging", (c) => c.body(null));
  app.get("/api/v1/:resource/:id", (c) => c.body(null));
  app.all("/api/*", (c) => c.body(null));
  app.route(
    "/api/auth",
    new Hono().get("/profile", (c) => c.body(null)),
  );
  app.get("/api/v1/botsmith", (c) => c.body(null));
  app.get("/api/account/export", (c) => c.body(null));
  app.post("/rpc/*", (c) => c.body(null));

  expect(systemContextRoutes(app)).toEqual([
    "ALL /api/*",
    "GET /api/auth/profile",
    "GET /api/v1/:resource/:id",
    "GET /api/v1/bots/:botId/avatar",
    "POST /api/v1/messaging",
  ]);
});
