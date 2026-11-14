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

/** The routes an app serves with a system database context, as `METHOD /path`. */
export function systemContextRoutes(app: Hono): string[] {
  const routes = inspectRoutes(app)
    .filter(
      (route) =>
        !route.isMiddleware &&
        SYSTEM_CONTEXT_PATHS.some(([contextPath]) => answersUnder(route.path, contextPath)),
    )
    .map((route) => `${route.method} ${route.path}`);
  return [...new Set(routes)].sort();
}
