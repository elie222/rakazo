import type { ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ComputerProviderSelection, StoredComputerSettings } from "./configured-sandbox.js";
import {
  ConfiguredSandbox,
  loadComputerOwnerSettings,
  loadComputerProviderSelection,
  parseStoredComputerSettings,
} from "./configured-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

class TestDesktop {
  readonly calls: string[] = [];
  provider(desktopId = "ecd-fake") {
    const provider = new FakeSandboxProvider();
    const provision = provider.provision.bind(provider);
    const descriptor = provider.describe();
    return Object.assign(provider, {
      describe: () => ({ ...descriptor, id: "desktop" }),
      provision: async (...args: Parameters<typeof provision>) => ({
        ...(await provision(...args)),
        kind: "desktop",
        providerRef: desktopId,
      }),
      ownsReference: (computer: ComputerRef) =>
        computer.kind === "desktop" && computer.providerRef === desktopId,
      billsWhileRunning: () => true,
      listFiles: async () => {
        this.calls.push("listFiles");
        return [];
      },
    });
  }
}

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

const values = {
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  regionId: "cn-hangzhou",
  desktopId: "ecd-fake",
  endUserId: "end-user",
  mcpUrl: "https://gateway.example.com/mcp",
  mcpToken: "test-token",
};

const settings: StoredComputerSettings = { provider: "desktop", values };

function setup(initial: ComputerProviderSelection) {
  let selection = initial;
  const primary = new FakeSandboxProvider();
  const desktop = new TestDesktop();
  const ownDesktop = new TestDesktop();
  /** The desktop each home key's owner saved for themselves. */
  const own = new Map<string, StoredComputerSettings>();
  const sandbox = new ConfiguredSandbox(primary, async () => selection, {
    loadOwn: async (homeKey) => own.get(homeKey) ?? null,
    createProvider: async (chosen) =>
      chosen.values.desktopId === settings.values.desktopId
        ? desktop.provider()
        : ownDesktop.provider(chosen.values.desktopId),
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
    const { sandbox, select } = setup({ provider: "default", settings: null });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect((await sandbox.provision({ botId: "a", homePath: "/h" }, ctx)).kind).toBe("fake");

    await select({ provider: "desktop", settings });
    expect(sandbox.describe().id).toBe("desktop");
    expect(await sandbox.provisionKind()).toBe("desktop");
    expect((await sandbox.provision({ botId: "b", homePath: "/h" }, ctx)).kind).toBe("desktop");
  });

  it("keeps every existing computer on the provider of its own kind", async () => {
    const { sandbox, select, desktop } = setup({ provider: "desktop", settings });
    await sandbox.refresh();
    const onSelected = await sandbox.provision({ botId: "w", homePath: "/h" }, ctx);
    await select({ provider: "default", settings });
    const onPrimary = await sandbox.provision(
      {
        botId: "p",
        homePath: "/h",
        providerRef: onSelected.providerRef,
        providerKind: "desktop",
      },
      ctx,
    );
    // A selected provider reference means nothing to the deployment's own provider.
    expect(onPrimary).toMatchObject({ kind: "fake", fresh: true });

    await sandbox.prepare(onSelected, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(onSelected, "", ctx);
    expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
    expect(sandbox.billsWhileRunning(onSelected)).toBe(true);
  });

  it("runs an account's Team Computer on the desktop it saved, and the rest on the default", async () => {
    const { sandbox, desktop, ownDesktop, own } = setup({ provider: "desktop", settings });
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();
    expect(await sandbox.provisionKind("mine")).toBe("desktop");
    const mine = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    const theirs = await sandbox.provision({ botId: "theirs", homePath: "/h" }, ctx);
    expect(mine.providerRef).toBe("ecd-own");
    expect(theirs.providerRef).toBe("ecd-fake");

    await sandbox.prepare(mine, ctx);
    desktop.calls.length = 0;
    ownDesktop.calls.length = 0;
    await sandbox.listFiles(mine, "", ctx);
    expect(ownDesktop.calls.some((call) => call === "listFiles")).toBe(true);
    expect(desktop.calls).toEqual([]);
  });

  it("keeps a computer on the default desktop until it starts again on its owner's", async () => {
    const { sandbox, desktop, own } = setup({ provider: "desktop", settings });
    await sandbox.refresh();
    const before = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();

    await sandbox.prepare(before, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(before, "", ctx);
    expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
    const after = await sandbox.provision(
      {
        botId: "mine",
        homePath: "/h",
        providerRef: before.providerRef,
        providerKind: "desktop",
      },
      ctx,
    );
    expect(after).toMatchObject({ providerRef: "ecd-own", fresh: true });
  });

  it("uses an account's own desktop even when the deployment default is a different provider", async () => {
    const { sandbox, own } = setup({ provider: "default", settings: null });
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect(await sandbox.provisionKind("mine")).toBe("desktop");
    expect((await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx)).kind).toBe("desktop");
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
    expect(await loadComputerOwnerSettings(prisma("team"), secrets, "team-k")).toEqual({
      ...settings,
      ciphertext: "c1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", spaceId: null, kind: "computer-provider" },
      }),
    );
    findFirst.mockClear();
    expect(await loadComputerOwnerSettings(prisma("dedicated"), secrets, "bot-k")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("probes background work for providers without their own check", async () => {
    const { sandbox } = setup({ provider: "default", settings: null });
    const computer: ComputerRef = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
    await expect(sandbox.inspectBackgroundWork(computer, "marker", ctx)).resolves.toMatch(
      /^(active|idle)$/,
    );
  });

  it("falls back to the deployment provider when the saved connection no longer decrypts", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: async () => ({
          computerProvider: "desktop",
          computerProviderSecretId: "s1",
        }),
      },
      secret: { findUnique: async () => ({ id: "s1", ciphertext: "old-key" }) },
    };
    const secrets = {
      load: async () => {
        throw new Error("unable to decrypt");
      },
    };
    expect(await loadComputerProviderSelection(prisma as unknown as PrismaClient, secrets)).toEqual(
      { provider: "default", settings: null },
    );
  });

  it("reads only complete saved provider settings", () => {
    expect(parseStoredComputerSettings(JSON.stringify(settings))).toEqual(settings);
    expect(
      parseStoredComputerSettings(
        JSON.stringify({ ...settings, values: { ...values, regionId: "" } }),
      )?.values.regionId,
    ).toBe("");
    expect(
      parseStoredComputerSettings(
        JSON.stringify({ ...settings, values: { ...values, mcpToken: "" } }),
      ),
    ).toBeNull();
    expect(parseStoredComputerSettings("not json")).toBeNull();
  });
});

it("reuses adapters only for the same ciphertext and credentials, and invalidates on secret changes", async () => {
  let saved: StoredComputerSettings = { ...settings, ciphertext: "encrypted-1" };
  let changed: ((ref: string) => void) | undefined;
  const createProvider = vi.fn(async () => new FakeSandboxProvider());
  const load = vi.fn(async () => ({ provider: saved.provider, settings: saved }));
  const sandbox = new ConfiguredSandbox(new FakeSandboxProvider(), load, {
    createProvider,
    onSecretChange: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  await sandbox.provisionKind();
  await sandbox.provisionKind();
  expect(load).toHaveBeenCalledTimes(2);
  expect(createProvider).toHaveBeenCalledTimes(1);
  changed?.("encrypted-1");
  await sandbox.provisionKind();
  expect(createProvider).toHaveBeenCalledTimes(2);
  saved = { ...saved, ciphertext: "encrypted-2" };
  await sandbox.provisionKind();
  expect(createProvider).toHaveBeenCalledTimes(3);
  saved = { ...saved, values: { ...values, mcpToken: "replacement-token" } };
  await sandbox.provisionKind();
  expect(createProvider).toHaveBeenCalledTimes(4);
});

it("routes an existing computer through a retained deployment connection after a provider switch", async () => {
  const { sandbox, select, desktop } = setup({ provider: "desktop", settings });
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  await select({
    provider: "test-cloud",
    settings: {
      provider: "test-cloud",
      values: { apiKey: "test-key" },
      connections: { desktop: values },
    },
  });
  await sandbox.prepare(computer, ctx);
  desktop.calls.length = 0;
  await sandbox.listFiles(computer, "", ctx);
  expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
});

it("refuses a reference from a connection that is no longer configured", async () => {
  const { sandbox, select } = setup({ provider: "desktop", settings });
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  await select({ provider: "default", settings: null });
  await expect(sandbox.prepare(computer, ctx)).rejects.toThrow("no longer configured");
});

it("refuses a desktop reference belonging to another account connection", async () => {
  const { sandbox, own } = setup({ provider: "default", settings: null });
  own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
  const computer = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
  await expect(sandbox.prepare({ ...computer, providerRef: "ecd-another" }, ctx)).rejects.toThrow(
    "no longer configured",
  );
});

vi.mock(
  "./computer-provider-registry.js",
  () => import("./fake-computer-settings.test-support.js"),
);
