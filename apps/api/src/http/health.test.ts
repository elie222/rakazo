import { InfisicalSecretStore } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { infisicalFake } from "../../../../packages/adapters/src/secrets/secret-store-fake.js";
import { DATABASE_CHECK_TIMEOUT_MS, healthRoutes } from "./health.js";

const app = healthRoutes(() => ({ runtime: "pi", sandbox: "docker", revision: "abc123" }));

describe("health routes", () => {
  it("reports degraded readiness during a store outage and recovers on later reads", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", {
      operationId: "test",
      traceId: "test",
      userId: "test",
      spaceId: "test",
      signal: new AbortController().signal,
    });
    await writer.close();
    fake.offline = true;
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const health = healthRoutes(() => ({ degraded: store.describe().capabilities.degraded }));
    try {
      const response = await health.request("/ready");
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false, degraded: true });
      expect((await health.request("/health")).status).toBe(200);
      fake.offline = false;
      await store.load(record.ref, record.id);
      expect((await health.request("/ready")).status).toBe(200);
    } finally {
      await store.close();
    }
  });
  it("reports not ready while the database is unreachable", async () => {
    let up = false;
    const health = healthRoutes(
      () => ({}),
      async () => {
        if (!up) throw new Error("connection refused");
      },
    );
    const response = await health.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      degraded: false,
      database: "unreachable",
    });
    expect((await health.request("/health")).status).toBe(200);
    up = true;
    expect((await health.request("/ready")).status).toBe(200);
  });

  it("answers 503 at the deadline while the database hangs, with one probe at a time", async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(() => new Promise<never>(() => {}));
      const health = healthRoutes(() => ({}), check);
      const first = health.request("/ready");
      const second = health.request("/ready");
      expect((await health.request("/health")).status).toBe(200);
      await vi.advanceTimersByTimeAsync(DATABASE_CHECK_TIMEOUT_MS);
      expect((await first).status).toBe(503);
      expect((await second).status).toBe(503);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps public liveness free of deployment details", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("serves details to direct requests on the API port", async () => {
    const response = await app.request("/internal/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      runtime: "pi",
      sandbox: "docker",
      revision: "abc123",
      telemetry: { failures: 0, lastFailureAt: null, degraded: false, droppedLines: 0 },
    });
  });

  it("hides details from requests that came through a reverse proxy", async () => {
    const proxied: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.7" },
      { forwarded: "for=203.0.113.7;proto=https" },
    ];
    for (const headers of proxied) {
      const response = await app.request("/internal/health", { headers });
      expect(response.status).toBe(404);
    }
  });

  /** Answers as a connection from `remoteAddress` would, which app.request has no socket for. */
  const fromPeer = (remoteAddress: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request("http://api.test/internal/health", { headers }), {
      incoming: { socket: { remoteAddress } },
    });

  it("answers deployment details to a caller on this deployment's network", async () => {
    // Loopback, the IPv4-mapped form a dual-stack listener reports, and the bridge address a
    // published container port reports, which is how the documented curls reach the API port.
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.18.0.1"]) {
      const response = await fromPeer(address);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json())).toContain("revision");
    }
  });

  it("hides details from a caller on the public internet", async () => {
    for (const address of ["203.0.113.7", "2001:db8::7"]) {
      const response = await fromPeer(address);
      expect(response.status).toBe(404);
    }
  });

  it("hides details from a local caller that arrived through the proxy", async () => {
    const response = await fromPeer("127.0.0.1", { "x-forwarded-for": "203.0.113.7" });
    expect(response.status).toBe(404);
  });
});
