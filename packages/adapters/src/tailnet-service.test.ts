import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";
import { saveTailnetConnection, setTailnetBotAccess } from "./tailnet-connections.js";
import { tailnetDatabase } from "./tailnet-connections.test-support.js";
import { FakeTailnetNodeHost, TailscaleApiEmulator } from "./tailnet-emulator.js";
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
  const service = new TailnetService({
    prisma: db.prisma,
    secretStore,
    nodeHost: options.nodeHost === false ? undefined : nodes,
    fetch: emulator.fetch,
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
  return { db, emulator, nodes, service, advance: (ms: number) => (now += ms) };
}

const RUN = { ...ALICE, botId: "helper", botName: "Home Lab Helper" };

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
    // One key for the check when saving, one for the node.
    expect(emulator.requests.filter((request) => request.method === "POST").length).toBe(3);
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
    (await service.dial(RUN, NAS, context())).destroy();
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
