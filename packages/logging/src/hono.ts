import type { MiddlewareHandler } from "hono";
import { correlationBindings, establishRequestCorrelation } from "./correlation.js";
import { formatTraceparent } from "./ids.js";
import { getLogger } from "./logger.js";
import type { Logger } from "./types.js";

export function requestLogging(logger?: Logger): MiddlewareHandler {
  return async (c, next) => {
    const log = logger ?? getLogger();
    const correlation = establishRequestCorrelation({
      requestId: c.req.header("x-request-id"),
      traceparent: c.req.header("traceparent"),
    });
    c.header("x-request-id", correlation.requestId);
    c.header("traceparent", formatTraceparent(correlation.traceId, correlation.spanId));
    const started = performance.now();
    return log.withContext(correlationBindings(correlation), async () => {
      let thrown: unknown;
      try {
        await next();
      } catch (error) {
        thrown = error;
        if (!c.error) throw error;
      } finally {
        const failure = c.error ?? thrown;
        if (failure) log.error("http.request.failed", failure);
        const status = failure && c.res.status < 400 ? 500 : c.res.status;
        const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
        log[level]("http.request.completed", {
          "http.method": c.req.method,
          "http.route": matchedRoute(c.req.path, c.req.routePath),
          "http.status": status,
          "http.duration_ms": Math.round(performance.now() - started),
        });
      }
    });
  };
}

function matchedRoute(path: string, routePath: string): string {
  if (routePath && routePath !== "/*") return routePath;
  return path;
}
