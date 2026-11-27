import type { Hono } from "hono";

/**
 * Replies under these paths carry a session cookie, an API key or a secret, so neither a client
 * nor an HTTP cache in front of the deployment may keep them.
 */
export const NO_STORE_PATHS = ["/api/auth/*", "/rpc/*"];

/**
 * Every path the keyed public API answers. The script assets and the public claim list under the
 * same prefix keep their own caching on purpose, so this names the routes rather than the prefix.
 */
export const KEYED_API_PATHS = [
  "/api/v1/chat/*",
  "/api/v1/models",
  "/api/v1/tasks",
  "/api/v1/tasks/*",
];

export function mountNoStore(app: Hono, paths: string[] = NO_STORE_PATHS): void {
  for (const path of paths) {
    app.use(path, async (c, next) => {
      // Set before the handler runs, so a reply produced by the error handler carries it too.
      c.header("cache-control", "no-store");
      await next();
    });
  }
}
