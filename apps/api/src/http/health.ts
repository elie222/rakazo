import { getConnInfo } from "@hono/node-server/conninfo";
import { logSinkHealth } from "@rakazo/logging";
import type { Context } from "hono";
import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port, so they are answered only to a caller on this machine; a
 * reverse proxy in front of the API makes the peer its own address, never loopback.
 */
export function healthRoutes(
  details: () => Record<string, unknown>,
  database?: () => Promise<unknown>,
) {
  const app = new Hono();
  // One probe at a time: polls during a hung check wait on it instead of taking more connections.
  let inFlight: Promise<boolean> | null = null;
  const probe = (check: () => Promise<unknown>) => {
    inFlight ??= Promise.resolve()
      .then(check)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  app.get("/ready", async (c) => {
    const degraded = details().degraded === true;
    const databaseUp = database ? await withinDeadline(probe(database)) : true;
    const ok = !degraded && databaseUp;
    return c.json(
      { ok, degraded, ...(databaseUp ? {} : { database: "unreachable" }) },
      ok ? 200 : 503,
    );
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", (c) => {
    // Both checks: a forwarded header means the request came through the edge, and the peer
    // itself must be on this deployment's own network, so a deployment behind a proxy that
    // adds no header is covered too. An in-process request (a test, or the app asking itself)
    // has no peer at all.
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    const peer = peerAddress(c);
    if (peer !== undefined && !isLocalPeer(peer)) return c.notFound();
    return c.json({ ok: true, ...details(), telemetry: logSinkHealth() });
  });
  return app;
}

export const DATABASE_CHECK_TIMEOUT_MS = 1500;

/** The address on the other end of the connection, or undefined for an in-process request. */
function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * The peer is on this deployment's own network: loopback, a private range, or the bridge
 * address a published container port reports. A request from the public internet is not,
 * which is the case a proxy that adds no forwarding header would otherwise expose.
 */
function isLocalPeer(address: string): boolean {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/, "");
  if (normalized === "::1") return true;
  if (/^(127|10|192\.168|169\.254)\./.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
  // IPv6 unique local (fc00::/7) and link local (fe80::/10).
  return /^(fc|fd)[0-9a-f]{2}:/.test(normalized) || normalized.startsWith("fe80:");
}

/** Readiness callers poll with short timeouts, so a hung database counts as unreachable. */
async function withinDeadline(check: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DATABASE_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
