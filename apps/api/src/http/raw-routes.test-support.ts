import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
import { METHODS } from "hono/router";
import { SYSTEM_CONTEXT_PATHS } from "./system-context-routes.js";

/** Whether a registered route pattern can answer a request under a `/base/*` path. */
function answersUnder(routePath: string, contextPath: string): boolean {
  const route = routePath.split("/");
  for (const [index, segment] of contextPath.replace(/\/\*$/, "").split("/").entries()) {
    const candidate = route[index];
    if (candidate === "*") return true;
    if (candidate !== segment && !candidate?.startsWith(":")) return false;
  }
  return true;
}

/** The routes an app answers itself, as `METHOD /path`. RPC is mounted as middleware, so not one. */
export function rawRoutes(app: Hono): string[] {
  const routes = inspectRoutes(app)
    .filter((route) => !route.isMiddleware)
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(routes)].sort();
}

/** The raw routes an app serves with a system database context. */
export function systemContextRoutes(app: Hono): string[] {
  return rawRoutes(app).filter((route) =>
    SYSTEM_CONTEXT_PATHS.some(([contextPath]) =>
      answersUnder(route.slice(route.indexOf(" ") + 1), contextPath),
    ),
  );
}

/**
 * Every method the framework routes by name, with HEAD, which it serves from the handler for GET.
 * Not OPTIONS: the CORS middleware answers every one before a route can.
 */
const ROUTED_METHODS = [
  "HEAD",
  ...METHODS.filter((method) => method !== "options").map((method) => method.toUpperCase()),
];

/** Requests that reach a raw route carrying no credentials, one per method it answers. */
export function anonymousRequests(route: string): Request[] {
  const [method = "", path = ""] = route.split(" ");
  const url = `http://localhost${path.replace(/:[^/]+|\*/g, "anonymous")}`;
  const methods = method === "ALL" ? ROUTED_METHODS : method === "GET" ? ["GET", "HEAD"] : [method];
  return methods.map((requestMethod) =>
    requestMethod === "GET" || requestMethod === "HEAD"
      ? new Request(url, { method: requestMethod })
      : // A route may check the content type first; JSON gets past that to its caller check.
        new Request(url, {
          method: requestMethod,
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
  );
}
