import { CLIENT_IP_HEADER } from "@rakazo/auth";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { mountAccountSessions } from "./account-sessions.js";
import { clientIpMiddleware } from "./client-ip.js";

const origin = "https://app.example.test";

it.each([undefined, "203.0.113.20"])(
  "passes only the resolved client IP to the shared auth callback (%s)",
  async (ip) => {
    const app = new Hono();
    app.use(
      "*",
      clientIpMiddleware(async () => ip, "x-forwarded-for"),
    );
    const handler = vi.fn(async () => Response.json({ success: true }));
    const handleAuthRequest = vi.fn(async (request: Request, clientIp: string | undefined) => {
      expect(new URL(request.url).pathname).toBe("/api/auth/accounts/remove");
      expect(clientIp).toBe(ip);
      expect(request.headers.get(CLIENT_IP_HEADER)).toBe(ip ?? null);
      expect(await request.json()).toEqual({ userId: "family" });
      return Response.json({ success: true });
    });
    mountAccountSessions(app, {
      auth: { handler } as never,
      prisma: {} as never,
      trustedOrigin: (value) => value === origin,
      handleAuthRequest,
    });
    const response = await app.request("https://api.example.test/api/accounts/remove", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: "198.51.100.99",
      },
      body: JSON.stringify({ userId: "family" }),
    });
    expect(response.status).toBe(200);
    expect(handleAuthRequest).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  },
);

it("strips a spoofed client IP before the direct auth fallback", async () => {
  const app = new Hono();
  const handler = vi.fn(async (request: Request) => {
    expect(request.headers.get(CLIENT_IP_HEADER)).toBeNull();
    return Response.json({ success: true });
  });
  mountAccountSessions(app, {
    auth: { handler } as never,
    prisma: {} as never,
    trustedOrigin: (value) => value === origin,
  });
  const response = await app.request("https://api.example.test/api/accounts/select", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      [CLIENT_IP_HEADER]: "198.51.100.99",
    },
    body: JSON.stringify({ userId: "family" }),
  });
  expect(response.status).toBe(200);
  expect(handler).toHaveBeenCalledOnce();
});

it("returns the configured server origin without exposing a session credential", async () => {
  const app = new Hono();
  mountAccountSessions(app, {
    auth: {
      api: { getSession: async () => null, listSavedAccounts: async () => [] },
    } as never,
    prisma: {} as never,
    trustedOrigin: (value) => value === origin,
    serverOrigin: "https://api.example.test",
  });
  const response = await app.request("https://api.example.test/api/accounts");
  expect(await response.json()).toEqual({
    activeUserId: null,
    accounts: [],
    serverOrigin: "https://api.example.test",
  });
});
