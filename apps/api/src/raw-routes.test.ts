import { Hono } from "hono";
import { expect, it } from "vitest";
import { anonymousRequests, rawRoutes, systemContextRoutes } from "./raw-routes.test-support.js";
import { SYSTEM_CONTEXT_PATHS } from "./system-context-routes.js";

function exampleApp() {
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
  app.post(
    "/api/upload",
    (_c, next) => next(),
    (c) => c.body(null),
  );
  app.use("/rpc/*", async (c, next) => (c.req.method === "POST" ? c.body(null) : next()));
  return app;
}

it("lists every route that can answer under a system-context path", () => {
  expect(systemContextRoutes(exampleApp())).toEqual([
    "ALL /api/*",
    "GET /api/auth/profile",
    "GET /api/v1/:resource/:id",
    "GET /api/v1/bots/:botId/avatar",
    "POST /api/v1/messaging",
  ]);
});

it("lists every route an app answers itself, once, without its middleware", () => {
  expect(rawRoutes(exampleApp())).toEqual([
    "ALL /api/*",
    "GET /api/account/export",
    "GET /api/auth/profile",
    "GET /api/v1/:resource/:id",
    "GET /api/v1/bots/:botId/avatar",
    "GET /api/v1/botsmith",
    "POST /api/upload",
    "POST /api/v1/messaging",
  ]);
});

it("builds requests without credentials that reach a route", async () => {
  const app = exampleApp();
  const reached = async (route: string) =>
    Promise.all(
      anonymousRequests(route).map(async (request) => {
        const { method, url, headers } = request;
        const body = request.body ? await request.clone().text() : null;
        const status = (await app.request(request)).status;
        return { method, path: new URL(url).pathname, headers: [...headers.keys()], body, status };
      }),
    );

  expect(await reached("GET /api/v1/bots/:botId/avatar")).toEqual([
    { method: "GET", path: "/api/v1/bots/anonymous/avatar", headers: [], body: null, status: 200 },
    { method: "HEAD", path: "/api/v1/bots/anonymous/avatar", headers: [], body: null, status: 200 },
  ]);
  expect(await reached("POST /api/upload")).toEqual([
    {
      method: "POST",
      path: "/api/upload",
      headers: ["content-type"],
      body: "{}",
      status: 200,
    },
  ]);
  expect(
    (await reached("ALL /api/*")).map(
      ({ method, path, body, status }) => `${method} ${path} ${body} ${status}`,
    ),
  ).toEqual([
    "HEAD /api/anonymous null 200",
    "GET /api/anonymous null 200",
    "POST /api/anonymous {} 200",
    "PUT /api/anonymous {} 200",
    "DELETE /api/anonymous {} 200",
    "PATCH /api/anonymous {} 200",
    "QUERY /api/anonymous {} 200",
  ]);
});
