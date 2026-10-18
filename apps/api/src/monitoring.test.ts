import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { MAX_MONITORING_ENVELOPE_BYTES, monitoringRoutes, parseDsn } from "./monitoring.js";

const DSN = "https://publickey@errors.example.com/8";
const CONFIG = { dsn: DSN, environment: "lg-acme", release: "abc" };

function envelope(dsn: string) {
  return `${JSON.stringify({ event_id: "1", dsn })}\n{"type":"event"}\n{"message":"boom"}\n`;
}

function recordingFetch(status = 200, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status, headers });
  }) as typeof fetch;
  return { calls, impl };
}

describe("monitoring routes", () => {
  it("parses DSNs into the envelope endpoint", () => {
    expect(parseDsn(DSN)).toEqual({
      publicKey: "publickey",
      envelopeUrl: "https://errors.example.com/api/8/envelope/",
    });
    expect(parseDsn("https://key@host.example.com/prefix/12")?.envelopeUrl).toBe(
      "https://host.example.com/prefix/api/12/envelope/",
    );
    expect(parseDsn("https://errors.example.com/8")).toBeUndefined();
    expect(parseDsn("ftp://key@host.example.com/1")).toBeUndefined();
  });

  it("reads browser config from the environment", () => {
    const base = {
      DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
      NODE_ENV: "test",
    };
    expect(loadEnv(base).browserMonitoring).toBeUndefined();
    expect(loadEnv({ ...base, SENTRY_BROWSER_DSN: " " }).browserMonitoring).toBeUndefined();
    expect(
      loadEnv({
        ...base,
        SENTRY_BROWSER_DSN: DSN,
        SENTRY_ENVIRONMENT: "lg-acme",
        GIT_SHA: "abc",
      }).browserMonitoring,
    ).toEqual(CONFIG);
    expect(
      loadEnv({ ...base, SENTRY_BROWSER_DSN: DSN, SENTRY_RELEASE: "v1", GIT_SHA: "abc" })
        .browserMonitoring?.release,
    ).toBe("v1");
    expect(
      loadEnv({ ...base, SENTRY_BROWSER_DSN: DSN, GIT_SHA: "unknown" }).browserMonitoring?.release,
    ).toBeUndefined();
  });

  it("serves the browser config, or nothing when disabled", async () => {
    const enabled = await monitoringRoutes(CONFIG).request("/api/monitoring/config");
    expect(enabled.headers.get("cache-control")).toBe("no-store");
    expect(await enabled.json()).toEqual({
      dsn: DSN,
      environment: "lg-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
    });
    const disabled = await monitoringRoutes(undefined).request("/api/monitoring/config");
    expect(await disabled.json()).toEqual({ dsn: null });
    const invalid = await monitoringRoutes({ dsn: "nope" }).request("/api/monitoring/config");
    expect(await invalid.json()).toEqual({ dsn: null });
  });

  it("forwards envelopes for the configured project with rate-limit headers", async () => {
    const { calls, impl } = recordingFetch(429, { "retry-after": "60", "x-other": "1" });
    const response = await monitoringRoutes(CONFIG, impl).request("/api/monitoring/tunnel", {
      method: "POST",
      body: envelope(DSN),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-other")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://errors.example.com/api/8/envelope/?sentry_key=publickey");
    expect(new TextDecoder().decode(calls[0]?.init.body as Uint8Array)).toBe(envelope(DSN));
  });

  it("refuses envelopes for other collectors, bad bodies, and oversized bodies", async () => {
    const { calls, impl } = recordingFetch();
    const app = monitoringRoutes(CONFIG, impl);
    const post = (body: string) => app.request("/api/monitoring/tunnel", { method: "POST", body });
    expect((await post(envelope("https://publickey@evil.example.com/8"))).status).toBe(403);
    expect((await post(envelope("https://otherkey@errors.example.com/8"))).status).toBe(403);
    expect((await post(envelope("https://publickey@errors.example.com/9"))).status).toBe(403);
    expect((await post("not json")).status).toBe(403);
    expect((await post("x".repeat(MAX_MONITORING_ENVELOPE_BYTES + 1))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("does not expose the tunnel when disabled and reports upstream failures", async () => {
    const disabled = await monitoringRoutes(undefined).request("/api/monitoring/tunnel", {
      method: "POST",
      body: envelope(DSN),
    });
    expect(disabled.status).toBe(404);
    const failing = (async () => {
      throw new Error("connect refused");
    }) as typeof fetch;
    const response = await monitoringRoutes(CONFIG, failing).request("/api/monitoring/tunnel", {
      method: "POST",
      body: envelope(DSN),
    });
    expect(response.status).toBe(502);
  });
});
