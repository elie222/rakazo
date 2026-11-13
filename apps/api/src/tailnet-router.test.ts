import { RPCHandler } from "@orpc/server/fetch";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  tag: string;
  ciphertext: string;
  botIds: string[];
};
type Where = { spaceId_userId: { spaceId: string; userId: string } };

const ALICE: Actor = {
  userId: "alice",
  spaceId: "home",
  email: "alice@example.test",
  isDeploymentOwner: false,
};
const BOB: Actor = { ...ALICE, userId: "bob", email: "bob@example.test" };
const CLIENT = { clientId: "client-a", clientSecret: "tskey-client-kTEST-secretvalue" };

/** tailnet_connections keyed by (spaceId, userId), and two bots in different Spaces. */
function harness(options: { available?: boolean; serverOrigin?: string | undefined } = {}) {
  const rows = new Map<string, Row>();
  const key = (where: Where) => `${where.spaceId_userId.spaceId}/${where.spaceId_userId.userId}`;
  const pick = (row: Row | undefined, select: Record<string, boolean>) =>
    row
      ? Object.fromEntries(Object.keys(select).map((name) => [name, row[name as keyof Row]]))
      : null;
  const byId = (where: { id: string }) => {
    if (!("id" in where)) throw new Error("Write tailnet connections by id");
    return [...rows.values()].find((row) => row.id === where.id);
  };
  const none = { count: async () => 0 };
  const prisma = {
    tailnetConnection: {
      findUnique: async ({ where, select }: { where: Where; select: Record<string, boolean> }) =>
        pick(rows.get(key(where)), select),
      // Writes by id only, as secret persistence requires.
      upsert: async (args: {
        where: { id: string };
        create: Omit<Row, "botIds">;
        update: Partial<Row>;
        select: Record<string, boolean>;
      }) => {
        const current = byId(args.where);
        const next = current ? { ...current, ...args.update } : { ...args.create, botIds: [] };
        rows.set(`${next.spaceId}/${next.userId}`, next);
        return pick(next, args.select);
      },
      update: async (args: {
        where: { id: string };
        data: Partial<Row>;
        select: Record<string, boolean>;
      }) => {
        const next = { ...(byId(args.where) as Row), ...args.data };
        rows.set(`${next.spaceId}/${next.userId}`, next);
        return pick(next, args.select);
      },
      deleteMany: async ({ where }: { where: { spaceId: string; userId: string } }) => ({
        count: rows.delete(`${where.spaceId}/${where.userId}`) ? 1 : 0,
      }),
      count: async () => 0,
    },
    bot: {
      findFirst: async ({ where }: { where: { id: string; spaceId: string } }) =>
        [
          { id: "helper", spaceId: "home" },
          { id: "elsewhere", spaceId: "work" },
        ].find((bot) => bot.id === where.id && bot.spaceId === where.spaceId) ?? null,
    },
    secret: none,
    botSecret: none,
    vaultCredential: none,
    integrationProviderConfig: none,
  };
  const service = {
    available: options.available ?? true,
    verify: vi.fn(async (_config: unknown, _signal: AbortSignal) => undefined),
    disconnect: vi.fn(async (_scope: unknown, _botId?: string) => undefined),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: new EncryptedSecretStore("test-only-encryption-key"),
    tailnet: {
      service,
      serverOrigin:
        "serverOrigin" in options ? options.serverOrigin : "https://rakazo.example.test",
    },
    env: { webOrigin: "https://rakazo.example.test", screenProxySecret: "fake-test-secret" },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, input?: unknown, actor: Actor = ALICE) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/tailnet/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor, sessionId: "session-1" } },
    );
    if (!response) throw new Error("Procedure did not match");
    const text = await response.text();
    return { status: response.status, text, json: (JSON.parse(text) as { json: unknown }).json };
  }
  return { rows, service, call };
}

describe("tailnet router", () => {
  it("connects the member's own client after Tailscale accepts it, and never returns it", async () => {
    const { call, service, rows } = harness();
    expect((await call("status")).json).toEqual({ unavailable: null, connection: null });
    const connected = await call("connect", CLIENT);
    expect(connected.json).toEqual({
      unavailable: null,
      connection: { tag: "tag:rakazo", botIds: [] },
    });
    expect(connected.text).not.toContain("tskey-client");
    expect(connected.text).not.toContain("client-a");
    expect(service.verify).toHaveBeenCalledWith(
      { ...CLIENT, tag: "tag:rakazo" },
      expect.any(AbortSignal),
    );
    expect([...rows.values()][0]?.ciphertext).not.toContain("tskey-client");
    // Replacing a client takes nodes joined with the old one off the tailnet.
    expect(service.disconnect).toHaveBeenCalledWith({ userId: "alice", spaceId: "home" });
  });

  it("explains a client Tailscale refuses, and saves nothing", async () => {
    const { call, service, rows } = harness();
    service.verify.mockRejectedValueOnce(
      new PrivateNetworkError("credentials", "Tailscale did not accept this OAuth client."),
    );
    const refused = await call("connect", CLIENT);
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("Tailscale did not accept this OAuth client.");
    expect(rows.size).toBe(0);
  });

  it("keeps each member's connection their own", async () => {
    const { call } = harness();
    await call("connect", CLIENT);
    await call("setBotAccess", { botId: "helper", enabled: true });
    expect((await call("status", undefined, BOB)).json).toEqual({
      unavailable: null,
      connection: null,
    });
    expect((await call("setBotAccess", { botId: "helper", enabled: true }, BOB)).status).toBe(400);
    expect((await call("status")).json).toMatchObject({ connection: { botIds: ["helper"] } });
  });

  it("lets only this Space's bots on, and takes a bot off at once", async () => {
    const { call, service } = harness();
    await call("connect", CLIENT);
    expect((await call("setBotAccess", { botId: "elsewhere", enabled: true })).status).toBe(404);
    await call("setBotAccess", { botId: "helper", enabled: true });
    const off = await call("setBotAccess", { botId: "helper", enabled: false });
    expect(off.json).toMatchObject({ connection: { botIds: [] } });
    expect(service.disconnect).toHaveBeenLastCalledWith(
      { userId: "alice", spaceId: "home" },
      "helper",
    );
  });

  it("disconnects the member's nodes with their connection", async () => {
    const { call, service } = harness();
    await call("connect", CLIENT);
    service.disconnect.mockClear();
    expect((await call("disconnect")).json).toEqual({ unavailable: null, connection: null });
    expect(service.disconnect).toHaveBeenCalledWith({ userId: "alice", spaceId: "home" });
  });

  it.each([
    [{ available: false }, "no_tailscale"],
    [{ serverOrigin: undefined }, "no_server_address"],
  ] as const)("says why the server can't (%o)", async (options, reason) => {
    const { call } = harness(options);
    expect((await call("status")).json).toEqual({ unavailable: reason, connection: null });
    expect((await call("connect", CLIENT)).status).toBe(400);
  });
});
