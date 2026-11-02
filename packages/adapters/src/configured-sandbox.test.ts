import type { ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ComputerProviderSelection, StoredWuyingSettings } from "./configured-sandbox.js";
import {
  ConfiguredSandbox,
  loadComputerOwnerWuyingSettings,
  loadComputerProviderSelection,
  parseStoredWuyingSettings,
} from "./configured-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { FakeWuyingDesktop } from "./wuying-sandbox.test-support.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

const settings = {
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  regionId: "cn-hangzhou",
  desktopId: "ecd-fake",
  endUserId: "end-user",
  mcpUrl: "https://gateway.example.com/mcp",
  mcpToken: "test-token",
};

function setup(initial: ComputerProviderSelection) {
  let selection = initial;
  const primary = new FakeSandboxProvider();
  const desktop = new FakeWuyingDesktop();
  const ownDesktop = new FakeWuyingDesktop();
  /** The desktop each home key's owner saved for themselves. */
  const own = new Map<string, StoredWuyingSettings>();
  const sandbox = new ConfiguredSandbox(primary, async () => selection, {
    loadOwn: async (homeKey) => own.get(homeKey) ?? null,
    createWuying: async (chosen) =>
      chosen.desktopId === settings.desktopId
        ? desktop.provider()
        : ownDesktop.provider(chosen.desktopId),
  });
  return {
    sandbox,
    desktop,
    ownDesktop,
    own,
    select: async (next: ComputerProviderSelection) => {
      selection = next;
      await sandbox.refresh();
    },
  };
}

describe("ConfiguredSandbox", () => {
  it("sends new computers to the provider chosen in Settings", async () => {
    const { sandbox, select } = setup({ wuying: false, settings: null });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect((await sandbox.provision({ botId: "a", homePath: "/h" }, ctx)).kind).toBe("fake");

    await select({ wuying: true, settings });
    expect(sandbox.describe().id).toBe("wuying");
    expect(await sandbox.provisionKind()).toBe("wuying");
    expect((await sandbox.provision({ botId: "b", homePath: "/h" }, ctx)).kind).toBe("wuying");
  });

  it("keeps every existing computer on the provider of its own kind", async () => {
    const { sandbox, select, desktop } = setup({ wuying: true, settings });
    await sandbox.refresh();
    const onWuying = await sandbox.provision({ botId: "w", homePath: "/h" }, ctx);
    await select({ wuying: false, settings });
    const onPrimary = await sandbox.provision(
      { botId: "p", homePath: "/h", providerRef: onWuying.providerRef, providerKind: "wuying" },
      ctx,
    );
    // A Wuying reference means nothing to the deployment's own provider.
    expect(onPrimary).toMatchObject({ kind: "fake", fresh: true });

    await sandbox.prepare(onWuying, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(onWuying, "", ctx);
    expect(desktop.calls.some((call) => call.tool === "fs_list")).toBe(true);
    expect(sandbox.billsWhileRunning(onWuying)).toBe(true);
  });

  it("runs an account's Team Computer on the desktop it saved, and the rest on the default", async () => {
    const { sandbox, desktop, ownDesktop, own } = setup({ wuying: true, settings });
    own.set("mine", { ...settings, desktopId: "ecd-own" });
    await sandbox.refresh();
    expect(await sandbox.provisionKind("mine")).toBe("wuying");
    const mine = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    const theirs = await sandbox.provision({ botId: "theirs", homePath: "/h" }, ctx);
    expect(mine.providerRef).toBe("ecd-own");
    expect(theirs.providerRef).toBe("ecd-fake");

    await sandbox.prepare(mine, ctx);
    desktop.calls.length = 0;
    ownDesktop.calls.length = 0;
    await sandbox.listFiles(mine, "", ctx);
    expect(ownDesktop.calls.some((call) => call.tool === "fs_list")).toBe(true);
    expect(desktop.calls).toEqual([]);
  });

  it("keeps a computer on the default desktop until it starts again on its owner's", async () => {
    const { sandbox, desktop, own } = setup({ wuying: true, settings });
    await sandbox.refresh();
    const before = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    own.set("mine", { ...settings, desktopId: "ecd-own" });
    await sandbox.refresh();

    await sandbox.prepare(before, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(before, "", ctx);
    expect(desktop.calls.some((call) => call.tool === "fs_list")).toBe(true);
    const after = await sandbox.provision(
      { botId: "mine", homePath: "/h", providerRef: before.providerRef, providerKind: "wuying" },
      ctx,
    );
    expect(after).toMatchObject({ providerRef: "ecd-own", fresh: true });
  });

  it("uses an account's own desktop even when the deployment default is not Wuying", async () => {
    const { sandbox, own } = setup({ wuying: false, settings: null });
    own.set("mine", { ...settings, desktopId: "ecd-own" });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect(await sandbox.provisionKind("mine")).toBe("wuying");
    expect((await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx)).kind).toBe("wuying");
  });

  it("reads an owner's desktop only for Team Computers", async () => {
    const secretRow = { id: "s1", ciphertext: "c1" };
    const findFirst = vi.fn(async () => secretRow);
    const prisma = (scope: string) =>
      ({
        computer: { findUnique: async () => ({ userId: "u1", scope }) },
        secret: { findFirst },
      }) as unknown as PrismaClient;
    const secrets = { load: async () => JSON.stringify(settings) };
    expect(await loadComputerOwnerWuyingSettings(prisma("team"), secrets, "team-k")).toEqual(
      settings,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", spaceId: null, kind: "wuying-computer" },
      }),
    );
    findFirst.mockClear();
    expect(await loadComputerOwnerWuyingSettings(prisma("dedicated"), secrets, "bot-k")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("probes background work for providers without their own check", async () => {
    const { sandbox } = setup({ wuying: false, settings: null });
    const computer: ComputerRef = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
    await expect(sandbox.inspectBackgroundWork(computer, "marker", ctx)).resolves.toMatch(
      /^(active|idle)$/,
    );
  });

  it("falls back to the deployment provider when the saved connection no longer decrypts", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: async () => ({ computerProvider: "wuying", computerProviderSecretId: "s1" }),
      },
      secret: { findUnique: async () => ({ id: "s1", ciphertext: "old-key" }) },
    };
    const secrets = {
      load: async () => {
        throw new Error("unable to decrypt");
      },
    };
    expect(await loadComputerProviderSelection(prisma as unknown as PrismaClient, secrets)).toEqual(
      { wuying: false, settings: null },
    );
  });

  it("reads only complete saved Wuying settings", () => {
    expect(parseStoredWuyingSettings(JSON.stringify(settings))).toEqual(settings);
    expect(parseStoredWuyingSettings(JSON.stringify({ ...settings, regionId: "" }))?.regionId).toBe(
      "cn-hangzhou",
    );
    expect(parseStoredWuyingSettings(JSON.stringify({ ...settings, mcpToken: "" }))).toBeNull();
    expect(parseStoredWuyingSettings("not json")).toBeNull();
  });
});
