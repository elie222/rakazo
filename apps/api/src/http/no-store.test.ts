import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { KEYED_API_PATHS, mountNoStore, NO_STORE_PATHS } from "./no-store.js";

/** Paths that answer a bot key, and paths under the same prefix that deliberately cache. */
const KEYED = ["/api/auth/session", "/rpc/bots/list", "/api/v1/models", "/api/v1/tasks/t1"];
const CACHED = ["/api/v1/assets/mermaid.js", "/api/v1/integration-claims", "/api/health"];

function app() {
  const hono = new Hono();
  mountNoStore(hono, [...NO_STORE_PATHS, ...KEYED_API_PATHS]);
  for (const path of [...KEYED, ...CACHED]) hono.get(path, (c) => c.json({ ok: true }));
  return hono;
}

describe("no-store replies", () => {
  it("never lets a cache keep a reply that carries a cookie or a key", async () => {
    const hono = app();
    for (const path of KEYED) {
      const response = await hono.request(path);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("keeps the deliberate caching of the paths that carry nothing private", async () => {
    const hono = app();
    for (const path of CACHED) {
      const response = await hono.request(path);
      expect(response.headers.get("cache-control"), path).toBeNull();
    }
  });

  it("keeps the header on a reply the error handler produces", async () => {
    const hono = new Hono();
    mountNoStore(hono);
    hono.get("/api/auth/session", () => {
      throw new Error("handler failed");
    });
    const response = await hono.request("/api/auth/session");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("names the keyed public API rather than its whole prefix", () => {
    expect(KEYED_API_PATHS).toContain("/api/v1/models");
    expect(KEYED_API_PATHS).not.toContain("/api/v1/*");
  });
});
