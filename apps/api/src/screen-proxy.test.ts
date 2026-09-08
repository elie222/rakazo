import { SCREEN_TARGET_ENDPOINT } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { addScreenProxyCapability, mountScreenTarget } from "./screen-proxy.js";

const secret = "fake-screen-secret";
const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 0,
  computerGeneration: 0,
  controlLeaseId: "lease",
};
function fixture(interactive = false) {
  const computer = {
    screenGeneration: 0,
    providerRef: "fake-provider",
    state: "running",
    controlHolder: "user",
    controlLeaseId: "lease",
    controlBotId: "bot",
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const bot = {
    id: "bot",
    computerId: "computer",
    archivedAt: null as Date | null,
    screenGeneration: 0,
    computer,
  };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => bot[key as keyof typeof bot] === value)
      ? bot
      : null,
  );
  const app = new Hono();
  mountScreenTarget(app, { bot: { findFirst } } as unknown as PrismaClient, secret);
  const url = addScreenProxyCapability(
    `http://127.0.0.1:49152/embed.html?view_only=${!interactive}`,
    secret,
    "https://app.example",
    scope,
  );
  const path = new URL(url).pathname;
  const request = (value = path, credential = secret) =>
    app.request(SCREEN_TARGET_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ path: value }),
    });
  return { bot, computer, findFirst, path, request };
}

describe("screen capability lifecycle authorization", () => {
  it("allows repeat assets and reconnects during the same active lifecycle", async () => {
    const { request, path } = fixture();
    expect((await request()).status).toBe(200);
    expect((await request(path.replace("/embed.html", "/websockify"))).status).toBe(200);
    expect((await request()).headers.get("cache-control")).toBe("no-store");
  });
  it("requires the proxy credential before looking up a capability", async () => {
    const { request, findFirst, path } = fixture();
    expect((await request(path, "wrong")).status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("rejects stopped computers and old URLs after restart at the same address", async () => {
    const { request, computer } = fixture();
    computer.state = "stopped";
    expect((await request()).status).toBe(403);
    computer.state = "running";
    computer.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it.each(["suspending", "error", "stopped"])("rejects computer state %s", async (state) => {
    const { request, computer } = fixture();
    computer.state = state;
    expect((await request()).status).toBe(403);
  });
  it("revokes archived, reassigned, and restored bots", async () => {
    const { request, bot } = fixture();
    bot.archivedAt = new Date();
    expect((await request()).status).toBe(403);
    bot.archivedAt = null;
    bot.computerId = "other";
    expect((await request()).status).toBe(403);
    bot.computerId = "computer";
    bot.screenGeneration++;
    expect((await request()).status).toBe(403);
  });
  it.each(["expiry", "release", "replacement", "holder", "bot"])(
    "revokes control on lease %s",
    async (change) => {
      const { request, computer } = fixture(true);
      expect((await request()).status).toBe(200);
      if (change === "expiry") computer.controlLeaseExpiresAt = new Date(0);
      if (change === "release") computer.controlLeaseId = "";
      if (change === "replacement") computer.controlLeaseId = "new-lease";
      if (change === "holder") computer.controlHolder = "agent";
      if (change === "bot") computer.controlBotId = "other";
      expect((await request()).status).toBe(403);
    },
  );
  it("rejects legacy stateless capabilities", async () => {
    expect(
      (await fixture().request("/novnc/MTI3LjAuMC4x/49152/view/9999999999999.fake/embed.html"))
        .status,
    ).toBe(403);
  });
  it("passes desktop and other non-http screen URLs through unsealed", () => {
    expect(
      addScreenProxyCapability("desktop://screen/computer", secret, "https://app.example", scope),
    ).toBe("desktop://screen/computer");
    expect(addScreenProxyCapability("local://preview", secret, "https://app.example", scope)).toBe(
      "local://preview",
    );
  });
});
