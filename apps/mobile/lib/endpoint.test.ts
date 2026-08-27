import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  apiBaseWarning,
  defaultApiBase,
  displayApiHost,
  normalizeApiBase,
  probeApiBase,
  usesCustomApiBase,
} from "./endpoint.js";

describe("normalizeApiBase", () => {
  it("trims, adds https, and keeps only the origin", () => {
    expect(normalizeApiBase("  app.example.com/rpc  ")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(normalizeApiBase("https://rakazo.example.com:8443/api/")).toEqual({
      ok: true,
      url: "https://rakazo.example.com:8443",
    });
    expect(normalizeApiBase("http://192.168.1.20:3100/")).toEqual({
      ok: true,
      url: "http://192.168.1.20:3100",
    });
  });

  it("rejects empty, non-http, and malformed values", () => {
    expect(normalizeApiBase("")).toMatchObject({ ok: false });
    expect(normalizeApiBase("   ")).toMatchObject({ ok: false });
    expect(normalizeApiBase("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(normalizeApiBase("ftp://files.example.com")).toMatchObject({ ok: false });
    expect(normalizeApiBase("http://")).toMatchObject({ ok: false });
  });

  it("strips credentials from the stored origin", () => {
    expect(normalizeApiBase("https://user:pass@app.example.com/rpc")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
  });
});

describe("display and warnings", () => {
  it("shows host and non-default port", () => {
    expect(displayApiHost("https://rakazo.example.com")).toBe("rakazo.example.com");
    expect(displayApiHost("http://10.0.0.8:3100")).toBe("10.0.0.8:3100");
  });

  it("warns on public http but not LAN or loopback", () => {
    expect(apiBaseWarning("https://app.example.com")).toBeNull();
    expect(apiBaseWarning("http://127.0.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://192.168.1.20:3100")).toBeNull();
    expect(apiBaseWarning("http://100.64.0.1:3100")).toBeNull();
    expect(apiBaseWarning("http://100.119.57.55:3100")).toBeNull();
    expect(apiBaseWarning("http://100.127.255.255:3100")).toBeNull();
    expect(apiBaseWarning("http://app.example.com")).toMatch(/https/i);
  });

  it("treats the compile-time default as not custom", () => {
    expect(usesCustomApiBase(defaultApiBase())).toBe(false);
    expect(usesCustomApiBase("https://rakazo.example.com")).toBe(true);
  });
});

describe("probeApiBase", () => {
  it("accepts a Rakazo /rpc/health response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://app.example.com", fetchImpl)).resolves.toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.com/rpc/health",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a host that is up but is not Rakazo", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(probeApiBase("https://example.com", fetchImpl)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("mobile custom server UI", () => {
  it("exposes a sign-in control that writes the stored origin", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const signIn = readFileSync(path.join(dir, "../app/sign-in.tsx"), "utf8");
    const api = readFileSync(path.join(dir, "api.ts"), "utf8");
    expect(signIn).toContain("Use a custom server");
    expect(signIn).toContain("saveApiBase");
    expect(signIn).toContain("probeApiBase");
    expect(api).toContain("currentApiBase()");
    expect(api).not.toMatch(/export const API /);
  });
});
