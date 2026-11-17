import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { deferred, flush } from "@rakazo/core/test-async";
import type { DbContext } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  FakeTailnetNodeHost,
  TailscaleApiEmulator,
} from "./providers/private-network/tailscale/tailnet-emulator.js";
import { EncryptedSecretStore } from "./secrets.js";
import { saveTailnetConnection, setTailnetBotAccess } from "./tailnet-connections.js";
import { tailnetDatabase } from "./tailnet-connections.test-support.js";
import {
  createTailscaledNodeHost,
  TAILNET_NOT_CONNECTED_MESSAGE,
  TAILNET_UNAVAILABLE_MESSAGE,
  TailnetService,
  tailnetNodeId,
} from "./tailnet-service.js";

const SECRET = "tskey-client-kTEST-secretvalue";
const ALICE = { userId: "alice", spaceId: "home" };
const BOB = { userId: "bob", spaceId: "home" };
const NAS = { host: "nas.tail1234.ts.net", port: 7 };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");

function context(): AdapterContext {
  return {
    operationId: "op",
    traceId: "op",
    spaceId: "home",
    userId: "alice",
    botId: "helper",
    signal: AbortSignal.timeout(5_000),
  };
}

async function setup(options: { nodeHost?: false } = {}) {
  let now = Date.parse("2026-11-12T00:00:00Z");
  const emulator = new TailscaleApiEmulator(() => now);
  emulator.addClient("client-a", {
    secret: SECRET,
    scopes: ["auth_keys", "devices:posture_attributes"],
    tags: ["tag:rakazo"],
  });
  const nodes = new FakeTailnetNodeHost(emulator);
  nodes.serve(NAS, (socket, from) => {
    socket.once("data", (chunk) => socket.write(`${from.hostname}:${chunk}`));
  });
  const db = tailnetDatabase([{ id: "helper", spaceId: "home" }]);
  // Set to hold the next auth key request open, as a slow tailnet API would.
  const keys: { held?: Promise<void> } = {};
  const service = new TailnetService({
    prisma: db.prisma,
    secretStore,
    nodeHost: options.nodeHost === false ? undefined : nodes,
    fetch: async (input, init) => {
      if (keys.held && input.endsWith("/keys") && init.method === "POST") await keys.held;
      return emulator.fetch(input, init);
    },
    now: () => now,
    idleMs: 60_000,
    sweepMs: 0,
  });
  await saveTailnetConnection({
    prisma: db.prisma,
    secretStore,
    scope: ALICE,
    config: { clientId: "client-a", clientSecret: SECRET, tag: "tag:rakazo" },
    verify: (config) => service.verify(config, AbortSignal.timeout(5_000)),
  });
  await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId: "helper", enabled: true });
  return { db, emulator, nodes, service, keys, advance: (ms: number) => (now += ms) };
}

const RUN = { ...ALICE, botId: "helper", botName: "Home Lab Helper" };

/** Close a connection and wait until it has gone, as its owner does. */
async function closed(socket: Duplex): Promise<void> {
  socket.destroy();
  await once(socket, "close");
}

const tokenRequests = (emulator: TailscaleApiEmulator) =>
  emulator.requests.filter((request) => request.path === "/api/v2/oauth/token").length;

async function rejection(promise: Promise<unknown>): Promise<PrivateNetworkError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PrivateNetworkError);
  return error as PrivateNetworkError;
}

describe("TailnetService", () => {
  it("joins the bot as its own node on the owner's tailnet and dials through it", async () => {
    const { emulator, service } = await setup();
    // Handed over paused, as a real node's connection is; the reader resumes it.
    const socket = (await service.dial(RUN, NAS, context())).resume();
    socket.write("hi");
    const [reply] = await once(socket, "data");
    expect(String(reply)).toBe("rakazo-home-lab-helper-helper:hi");
    expect(emulator.devices.get(tailnetNodeId(RUN))?.attributes).toEqual({
      "custom:rakazoSpace": "home",
      "custom:rakazoBot": "helper",
      "custom:rakazoUser": "alice",
    });
    socket.destroy();
  });

  it("reuses the node for later dials", async () => {
    const { emulator, service } = await setup();
    (await service.dial(RUN, NAS, context())).destroy();
    (await service.dial(RUN, NAS, context())).destroy();
    // A token and a key for the check when saving, then a token and a key for the node.
    expect(emulator.requests.filter((request) => request.method === "POST").length).toBe(4);
  });

  it("never dials from another member's run, even through the same bot", async () => {
    const { emulator, service } = await setup();
    const refused = await rejection(service.dial({ ...RUN, ...BOB }, NAS, context()));
    expect(refused.code).toBe("permission");
    expect(refused.message).toBe(TAILNET_NOT_CONNECTED_MESSAGE);
    expect(emulator.devices.size).toBe(0);
  });

  it("refuses a bot its owner didn't allow", async () => {
    const { service } = await setup();
    const refused = await rejection(
      service.dial({ ...RUN, botId: "other", botName: "Other" }, NAS, context()),
    );
    expect(refused.code).toBe("permission");
  });

  it("says why on a server without tailscaled", async () => {
    const { service } = await setup({ nodeHost: false });
    expect(service.available).toBe(false);
    const refused = await rejection(service.dial(RUN, NAS, context()));
    expect(refused.message).toBe(TAILNET_UNAVAILABLE_MESSAGE);
  });

  it("takes a member's nodes off the tailnet when they disconnect", async () => {
    const { emulator, service } = await setup();
    const socket = await service.dial(RUN, NAS, context());
    await service.disconnect({ userId: "bob", spaceId: "home" });
    expect(emulator.devices.size).toBe(1);
    await service.disconnect(ALICE, "helper");
    expect(socket.destroyed).toBe(true);
    expect(emulator.devices.size).toBe(0);
  });

  it("drops another process's node on the next dial once access is turned off", async () => {
    const { db, emulator, nodes, service } = await setup();
    const worker = new TailnetService({
      prisma: db.prisma,
      secretStore,
      nodeHost: nodes,
      fetch: emulator.fetch,
      sweepMs: 0,
    });
    const open = await worker.dial(RUN, NAS, context());
    await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId: "helper", enabled: false });
    await service.tidy();
    expect(open.destroyed).toBe(false);
    const refused = await rejection(worker.dial(RUN, NAS, context()));
    expect(refused.message).toBe(TAILNET_NOT_CONNECTED_MESSAGE);
    expect(open.destroyed).toBe(true);
    expect(emulator.devices.size).toBe(0);
    await worker.close();
  });

  it("drops its node when a tunnel recheck finds access turned off", async () => {
    const { db, emulator, service } = await setup();
    const open = await service.dial(RUN, NAS, context());
    await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId: "helper", enabled: false });
    expect(await service.allows(RUN)).toBe(false);
    expect(open.destroyed).toBe(true);
    expect(emulator.devices.size).toBe(0);
  });

  it("takes a node off in every process once its bot is turned off", async () => {
    const { db, emulator, nodes, service } = await setup();
    // Another process (a worker) with its own node for the same bot.
    const worker = new TailnetService({
      prisma: db.prisma,
      secretStore,
      nodeHost: nodes,
      fetch: emulator.fetch,
      sweepMs: 0,
    });
    const elsewhere = await worker.dial(RUN, NAS, context());
    await service.tidy();
    expect(elsewhere.destroyed).toBe(false);
    // The member turns the bot off; the API takes its own nodes off, never the worker's.
    await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId: "helper", enabled: false });
    await worker.tidy();
    expect(elsewhere.destroyed).toBe(true);
    expect(emulator.devices.size).toBe(0);
  });

  it("leaves idle nodes and rejoins on the next dial", async () => {
    const { emulator, service, advance } = await setup();
    await closed(await service.dial(RUN, NAS, context()));
    advance(30_000);
    await service.leaveIdle();
    expect(emulator.devices.size).toBe(1);
    advance(60_000);
    await service.leaveIdle();
    expect(emulator.devices.size).toBe(0);
    (await service.dial(RUN, NAS, context())).destroy();
    expect(emulator.devices.size).toBe(1);
    await service.close();
    expect(emulator.devices.size).toBe(0);
  });

  it("keeps a node carrying an open connection past the idle time", async () => {
    const { emulator, service, advance } = await setup();
    const socket = await service.dial(RUN, NAS, context());
    advance(120_000);
    await service.leaveIdle();
    expect(socket.destroyed).toBe(false);
    await closed(socket);
    advance(120_000);
    await service.leaveIdle();
    expect(emulator.devices.size).toBe(0);
  });

  it("rechecks access as each node's member, outside any request", async () => {
    const { db, emulator, service } = await setup();
    const seen: Array<DbContext | undefined> = [];
    const findUnique = db.prisma.tailnetConnection.findUnique.bind(db.prisma.tailnetConnection);
    vi.spyOn(db.prisma.tailnetConnection, "findUnique").mockImplementation(((args: never) => {
      seen.push(currentDbContext());
      return findUnique(args);
    }) as never);
    await service.dial(RUN, NAS, context());
    seen.length = 0;
    await service.tidy();
    expect(seen).toEqual([{ kind: "tenant", spaceId: "home", userId: "alice" }]);
    expect(emulator.devices.size).toBe(1);
  });

  it("joins again only once the node it replaces has left", async () => {
    const { nodes, service } = await setup();
    await closed(await service.dial(RUN, NAS, context()));
    const stopping = deferred();
    const stop = nodes.stop.bind(nodes);
    vi.spyOn(nodes, "stop").mockImplementationOnce(async (nodeId) => {
      await stopping.promise;
      await stop(nodeId);
    });
    const start = vi.spyOn(nodes, "start");
    const leaving = service.disconnect(ALICE, "helper");
    const dialing = service.dial(RUN, NAS, context());
    await flush();
    expect(start).not.toHaveBeenCalled();
    stopping.resolve();
    await leaving;
    await closed(await dialing);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("never joins a bot taken off while its key was still being made", async () => {
    const { emulator, nodes, service, keys } = await setup();
    const minting = deferred();
    keys.held = minting.promise;
    const start = vi.spyOn(nodes, "start");
    const dialing = service.dial(RUN, NAS, context()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(emulator.requests.at(-1)?.path).toBe("/api/v2/oauth/token"));
    await service.disconnect(ALICE, "helper");
    minting.resolve();
    expect(await dialing).toBeInstanceOf(Error);
    expect(start).not.toHaveBeenCalled();
    expect(emulator.devices.size).toBe(0);
  });

  it("forgets an OAuth client once no node uses it", async () => {
    const { emulator, service } = await setup();
    await closed(await service.dial(RUN, NAS, context()));
    const tokens = tokenRequests(emulator);
    await closed(await service.dial(RUN, NAS, context()));
    expect(tokenRequests(emulator)).toBe(tokens);
    await service.disconnect(ALICE);
    await closed(await service.dial(RUN, NAS, context()));
    expect(tokenRequests(emulator)).toBe(tokens + 1);
  });
});

describe("createTailscaledNodeHost", () => {
  it("needs both binaries on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rkz-bin-"));
    try {
      await writeFile(join(dir, "tailscaled"), "");
      await chmod(join(dir, "tailscaled"), 0o755);
      expect(await createTailscaledNodeHost(join(dir, "run"), dir)).toBeUndefined();
      await writeFile(join(dir, "tailscale"), "");
      await chmod(join(dir, "tailscale"), 0o755);
      expect(await createTailscaledNodeHost(join(dir, "run"), dir)).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
