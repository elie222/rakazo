import type { Actor } from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountRealtimeVoiceRoutes } from "./realtime-voice.js";

function setup(options: { signedIn?: boolean; enabled?: boolean } = {}) {
  const app = new Hono();
  const authenticate = vi.fn(async () => (options.signedIn ? ({ userId: "user" } as Actor) : null));
  mountRealtimeVoiceRoutes(
    app,
    {} as Parameters<typeof mountRealtimeVoiceRoutes>[1],
    authenticate,
    (origin) => origin === "http://localhost",
    options.enabled ?? true,
    new AbortController().signal,
  );
  return { app, authenticate };
}

describe("realtime voice HTTP admission", () => {
  it("keeps calls unavailable when the server has disabled voice calls", async () => {
    const { app } = setup({ enabled: false });
    expect(
      (
        await app.request("/api/voice/realtime", {
          method: "POST",
          headers: { origin: "http://localhost" },
        })
      ).status,
    ).toBe(404);
  });

  it("rejects cross-origin offers before authenticating", async () => {
    const { app, authenticate } = setup({ signedIn: true });
    expect(
      (
        await app.request("/api/voice/realtime", {
          method: "POST",
          headers: { origin: "http://other.local" },
        })
      ).status,
    ).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("does not issue sessions to an anonymous caller", async () => {
    const { app } = setup();
    expect(
      (
        await app.request("/api/voice/realtime", {
          method: "POST",
          headers: { origin: "http://localhost" },
        })
      ).status,
    ).toBe(401);
  });

  it("rejects malformed and oversized user-controlled offers", async () => {
    const { app } = setup({ signedIn: true });
    const offer = (body: string) =>
      app.request("/api/voice/realtime", {
        method: "POST",
        headers: { origin: "http://localhost" },
        body,
      });
    expect((await offer("{")).status).toBe(400);
    expect((await offer("{}")).status).toBe(400);
    expect((await offer("a".repeat(72 * 1024))).status).toBe(413);
  });
});
