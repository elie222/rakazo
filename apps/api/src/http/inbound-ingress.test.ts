import { describe, expect, it } from "vitest";
import { inboundOnly, isInboundDelivery } from "./inbound-ingress.js";
import { INBOUND_DELIVERY_ROUTES, SESSIONLESS_ROUTES } from "./sessionless-routes.js";

describe("the inbound routes", () => {
  it("are sessionless routes, with the same reason", () => {
    for (const [key, reason] of Object.entries(INBOUND_DELIVERY_ROUTES)) {
      expect(SESSIONLESS_ROUTES[key], key).toBe(reason);
    }
  });

  // A new webhook added to SESSIONLESS_ROUTES alone would stay unreachable through the ingress.
  it("include every sessionless route that takes a delivery", () => {
    const deliveries = Object.keys(SESSIONLESS_ROUTES).filter((key) =>
      /\/(webhook|github|inbound|events)(\/|$)/.test(key.split(" ")[1] ?? ""),
    );
    expect(deliveries.sort()).toEqual(Object.keys(INBOUND_DELIVERY_ROUTES).sort());
  });
});

describe("isInboundDelivery", () => {
  it.each([
    ["POST", "/api/v1/bots/bot_1/webhook"],
    ["POST", "/api/v1/bots/bot_1/github"],
    ["GET", "/api/v1/messaging/webhook/whatsapp"],
    ["POST", "/api/v1/messaging/webhook/telegram"],
    ["POST", "/api/v1/email/inbound"],
    ["POST", "/api/meetings/events"],
  ])("lets %s %s through", (method, path) => {
    expect(isInboundDelivery(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/"],
    ["GET", "/app"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/capabilities"],
    ["POST", "/rpc/me"],
    ["GET", "/api/v1/bots/bot_1/webhook"],
    ["POST", "/api/v1/bots//webhook"],
    ["POST", "/api/v1/bots/bot_1/webhook/extra"],
    ["POST", "/api/v1/bots/bot_1/avatar"],
    ["GET", "/api/v1/messaging/webhook"],
    ["GET", "/health"],
    ["GET", "/internal/health"],
  ])("refuses %s %s", (method, path) => {
    expect(isInboundDelivery(method, path)).toBe(false);
  });
});

describe("inboundOnly", () => {
  const app = inboundOnly(() => new Response("app", { status: 200 }));

  it("answers 404 without reaching the app for any other path", async () => {
    const response = await app(new Request("https://hooks.example.test/api/auth/session"), {});
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it("resolves dot segments before it decides", async () => {
    const response = await app(
      new Request("https://hooks.example.test/api/v1/bots/a/../../../auth/session", {
        method: "POST",
      }),
      {},
    );
    expect(response.status).toBe(404);
  });

  it("passes an inbound delivery to the app unchanged", async () => {
    const response = await app(
      new Request("https://hooks.example.test/api/v1/bots/bot_1/webhook", { method: "POST" }),
      {},
    );
    expect(await response.text()).toBe("app");
  });
});
