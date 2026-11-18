import { PrivateNetworkError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets/secrets.js";
import {
  getTailnetConnection,
  removeTailnetConnection,
  resolveRunTailnet,
  saveTailnetConnection,
  setTailnetBotAccess,
  TailnetBotNotFoundError,
} from "./tailnet-connections.js";
import { tailnetDatabase as database } from "./tailnet-connections.test-support.js";

const ALICE = { userId: "alice", spaceId: "home" };
const BOB = { userId: "bob", spaceId: "home" };
const CONFIG = { clientId: "client-a", clientSecret: "tskey-client-a-secret", tag: "tag:rakazo" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");

async function connected(bots = [{ id: "helper", spaceId: "home" }]) {
  const db = database(bots);
  await saveTailnetConnection({
    prisma: db.prisma,
    secretStore,
    scope: ALICE,
    config: CONFIG,
    verify: async () => {},
  });
  await setTailnetBotAccess({ prisma: db.prisma, scope: ALICE, botId: "helper", enabled: true });
  return db;
}

describe("tailnet connections", () => {
  it("stores the client encrypted and shows its owner only the tag and bots", async () => {
    const { rows, prisma } = await connected();
    const [row] = rows.values();
    expect(row?.ciphertext).not.toContain("tskey-client-a-secret");
    expect(await getTailnetConnection(prisma, ALICE)).toEqual({
      tag: "tag:rakazo",
      botIds: ["helper"],
    });
  });

  it("is used only in the owner's runs, and only for the bots they allowed", async () => {
    const { prisma } = await connected();
    const resolve = (run: { userId: string; spaceId: string; botId: string }) =>
      resolveRunTailnet({ prisma, secretStore, run });
    expect(await resolve({ ...ALICE, botId: "helper" })).toEqual(CONFIG);
    // Another member messaging the same bot in the same Space gets nothing.
    expect(await resolve({ ...BOB, botId: "helper" })).toBeUndefined();
    expect(await getTailnetConnection(prisma, BOB)).toBeNull();
    // The owner in another Space, or with a bot they didn't allow, gets nothing.
    expect(await resolve({ userId: "alice", spaceId: "work", botId: "helper" })).toBeUndefined();
    expect(await resolve({ ...ALICE, botId: "other" })).toBeUndefined();
  });

  it("keeps another member's connection separate from the owner's", async () => {
    const { prisma } = await connected();
    await saveTailnetConnection({
      prisma,
      secretStore,
      scope: BOB,
      config: { ...CONFIG, clientId: "client-b" },
      verify: async () => {},
    });
    expect(await getTailnetConnection(prisma, BOB)).toEqual({ tag: "tag:rakazo", botIds: [] });
    expect(await resolveRunTailnet({ prisma, secretStore, run: { ...BOB, botId: "helper" } })).toBe(
      undefined,
    );
    expect(
      (await resolveRunTailnet({ prisma, secretStore, run: { ...ALICE, botId: "helper" } }))
        ?.clientId,
    ).toBe("client-a");
  });

  it("saves nothing when Tailscale refuses the client", async () => {
    const { rows, prisma } = database();
    await expect(
      saveTailnetConnection({
        prisma,
        secretStore,
        scope: ALICE,
        config: CONFIG,
        verify: async () => {
          throw new Error("Tailscale did not accept this OAuth client.");
        },
      }),
    ).rejects.toThrow("did not accept");
    expect(rows.size).toBe(0);
  });

  it("tells a refused client from a tailnet service that couldn't be reached", async () => {
    const { rows, prisma } = database();
    const save = (error: PrivateNetworkError) =>
      saveTailnetConnection({
        prisma,
        secretStore,
        scope: ALICE,
        config: CONFIG,
        verify: async () => {
          throw error;
        },
      });
    await expect(
      save(new PrivateNetworkError("credentials", "Check its ID and secret.")),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST", message: "Check its ID and secret." });
    await expect(
      save(new PrivateNetworkError("unavailable", "Tailscale could not be reached.")),
    ).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
    expect(rows.size).toBe(0);
  });

  it("agrees on one row when two first connections are saved at once", async () => {
    const { rows, prisma } = database();
    const save = (secret: string) =>
      saveTailnetConnection({
        prisma,
        secretStore,
        scope: ALICE,
        config: { ...CONFIG, clientSecret: secret },
        verify: async () => undefined,
      });
    // The other save's insert lands between this one's read and its write.
    const upsert = prisma.tailnetConnection.upsert.bind(prisma.tailnetConnection);
    vi.spyOn(prisma.tailnetConnection, "upsert").mockImplementationOnce((async (
      args: Parameters<typeof upsert>[0],
    ) => {
      await upsert(args);
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }) as never);
    await Promise.all([save("tskey-client-kTEST-first"), save("tskey-client-kTEST-second")]);
    expect(rows.size).toBe(1);
    expect(await getTailnetConnection(prisma, ALICE)).toEqual({ tag: CONFIG.tag, botIds: [] });
  });

  it("replaces the client and keeps the allowed bots", async () => {
    const { prisma } = await connected();
    await saveTailnetConnection({
      prisma,
      secretStore,
      scope: ALICE,
      config: { ...CONFIG, clientId: "client-new", tag: "tag:bots" },
      verify: async () => {},
    });
    expect(await getTailnetConnection(prisma, ALICE)).toEqual({
      tag: "tag:bots",
      botIds: ["helper"],
    });
    expect(
      (await resolveRunTailnet({ prisma, secretStore, run: { ...ALICE, botId: "helper" } }))
        ?.clientId,
    ).toBe("client-new");
  });

  it("deletes the new value from the store when the write fails", async () => {
    const { prisma } = database();
    const store = new EncryptedSecretStore("test-only-encryption-key");
    const deleted = vi.spyOn(store, "delete");
    prisma.tailnetConnection.upsert = (async () => {
      throw new Error("write failed");
    }) as never;
    await expect(
      saveTailnetConnection({
        prisma,
        secretStore: store,
        scope: ALICE,
        config: CONFIG,
        verify: async () => {},
      }),
    ).rejects.toThrow("write failed");
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it("only lets bots of the same Space on", async () => {
    const { prisma } = await connected([
      { id: "helper", spaceId: "home" },
      { id: "elsewhere", spaceId: "work" },
    ]);
    await expect(
      setTailnetBotAccess({ prisma, scope: ALICE, botId: "elsewhere", enabled: true }),
    ).rejects.toBeInstanceOf(TailnetBotNotFoundError);
    expect(
      await setTailnetBotAccess({ prisma, scope: ALICE, botId: "helper", enabled: false }),
    ).toEqual({ tag: "tag:rakazo", botIds: [] });
    expect(
      await setTailnetBotAccess({ prisma, scope: BOB, botId: "helper", enabled: true }),
    ).toBeNull();
  });

  it("removes only the owner's connection", async () => {
    const { prisma } = await connected();
    expect(await removeTailnetConnection({ prisma, scope: BOB })).toBe(false);
    expect(await removeTailnetConnection({ prisma, scope: ALICE })).toBe(true);
    expect(
      await resolveRunTailnet({ prisma, secretStore, run: { ...ALICE, botId: "helper" } }),
    ).toBeUndefined();
  });
});
