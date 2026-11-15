import type { Hono } from "hono";
import { inspectRoutes } from "hono/dev";
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

/** Requests that reach a raw route carrying no credentials, one per method it answers. */
export function anonymousRequests(route: string): Request[] {
  const [method = "", path = ""] = route.split(" ");
  const url = `http://localhost${path.replace(/:[^/]+|\*/g, "anonymous")}`;
  return (method === "ALL" ? ["GET", "POST"] : [method]).map((requestMethod) =>
    requestMethod === "GET"
      ? new Request(url)
      : // A route may check the content type first; JSON gets past that to its caller check.
        new Request(url, {
          method: requestMethod,
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
  );
}
