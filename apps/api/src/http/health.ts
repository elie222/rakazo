import { isPrivateNetworkAddress } from "@rakazo/contracts/network-host";
import type { PrismaClient } from "@rakazo/db";
import { logSinkHealth } from "@rakazo/logging";
import { Hono } from "hono";
import { socketPeer } from "./socket-peer.js";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port: a caller on this deployment's own network (loopback, or the bridge
 * a published container port reports) whose request did not come through a forwarding proxy.
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
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    // The peer check also covers a proxy that adds no forwarding header. An in-process request
    // (a test, or the app asking itself) has no peer.
    const peer = socketPeer(c);
    if (peer !== undefined && !isPrivateNetworkAddress(unmapped(peer))) return c.notFound();
    return c.json({ ok: true, ...details(), telemetry: logSinkHealth() });
  });
  return app;
}

export const DATABASE_CHECK_TIMEOUT_MS = 1500;

/** A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`. */
function unmapped(address: string): string {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
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

/** The statement timeout ends a stuck probe on the server too, freeing its connection. */
export function databaseProbe(prisma: PrismaClient) {
  return () =>
    prisma.$transaction([
      prisma.$executeRaw`SET LOCAL statement_timeout = 1500`,
      prisma.$queryRaw`SELECT 1`,
    ]);
}
