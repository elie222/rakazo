import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer, replaceComputer } from "./computer-lifecycle.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import type { StoredHome } from "./home-object-store.js";
import { ObjectAgentHomeStore } from "./home-object-store.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";

const context = {
  operationId: "recovery",
  traceId: "recovery",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: "fake" | "desktop" = "fake") {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-recovery-"));
  roots.push(root);
  const sandbox: SandboxProvider =
    provider === "desktop" ? new DesktopSandboxProvider({ root }) : new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  await home.writeFile("bot", "notes.txt", "checkpoint", context);
  await sandbox.writeFile(
    first,
    { path: "notes.txt", content: new TextEncoder().encode("live work") },
    context,
  );
  const row = {
    id: "computer",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    providerRef: first.providerRef as string | null,
    kind: first.kind,
    controlHolder: "none",
    controlLeaseId: null,
    maintenanceId: null as string | null,
    homeRevision: "saved",
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };
  // Model the atomic scalar predicates used by claims, including stale references
  // and the updatedAt claim stamp used for booting reclaim / end-of-boot writes.
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
        (key) => !(key in where) || where[key] === row[key as keyof typeof row],
      );
      if (!matches) return { count: 0 };
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) =>
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data),
    ),
  };
  const deps = {
    prisma: {
      computer,
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { deps, row, computer, first, root };
}

/** An object-backed home store over an in-memory bucket; `revision` is the home's stored one. */
function objectHome(root: string, revision: string | null = null) {
  const stored: StoredHome = {
    storageId: "home",
    revision,
    key: { id: "key", spaceId: "space", version: 1, key: randomBytes(32) },
  };
  return new ObjectAgentHomeStore(path.join(root, "object-homes"), new MemoryObjectStorage(), {
    load: async () => stored,
    create: async () => stored,
    advance: async (_homeKey, _storageId, from, to) => {
      if (stored.revision !== from) return false;
      stored.revision = to;
      return true;
    },
    revisions: async () => new Map(),
    kinds: async () => new Map(),
  });
}

describe("computer recovery preserves live work", () => {
  it("brings an object-stored home into the local cache before a Docker computer boots on it", async () => {
    const { deps, row, root } = await fixture();
    row.state = "stopped";
    row.providerRef = null;
    // Host access was turned off, so a computer that last ran on this Mac now boots in Docker.
    row.kind = "desktop";
    deps.sandbox.provisionKind = async () => "docker";
    const home = objectHome(root);
    const hydrate = vi.spyOn(home, "hydrate");
    const provision = vi.spyOn(deps.sandbox, "provision");

    await provisionComputer({ ...deps, home }, row.id, context);

    expect(hydrate).toHaveBeenCalledWith("bot");
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      provision.mock.invocationCallOrder[0]!,
    );
  });

  it("downloads the home before boot when the provider's own kind mounts it, whatever the row last ran on", async () => {
    const { deps, row, root } = await fixture();
    row.state = "stopped";
    row.providerRef = null;
    row.kind = "e2b";
    const own = deps.sandbox.describe();
    vi.spyOn(deps.sandbox, "describe").mockReturnValue({ ...own, id: "docker" });
    const home = objectHome(root);
    const hydrate = vi.spyOn(home, "hydrate");
    const provision = vi.spyOn(deps.sandbox, "provision");

    await provisionComputer({ ...deps, home }, row.id, context);

    expect(hydrate).toHaveBeenCalledWith("bot");
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      provision.mock.invocationCallOrder[0]!,
    );
  });

  it("fails a start that mounts a home it chose not to download, and downloads on the next", async () => {
    const { deps, row, root, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.state = "stopped";
    row.providerRef = null;
    // Host access is turned off between choosing the kind and provisioning.
    deps.sandbox.provisionKind = async () => "desktop";
    const provisionFake = deps.sandbox.provision.bind(deps.sandbox);
    vi.spyOn(deps.sandbox, "provision").mockImplementation(async (request, ctx) => ({
      ...(await provisionFake(request, ctx)),
      kind: "docker",
    }));
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const home = objectHome(root);
    const hydrate = vi.spyOn(home, "hydrate");

    await expect(provisionComputer({ ...deps, home }, row.id, context)).rejects.toThrow(
      "Computer host changed while it was starting",
    );
    expect(hydrate).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(row.state).toBe("error");

    deps.sandbox.provisionKind = async () => "docker";
    await provisionComputer({ ...deps, home }, row.id, context);
    expect(hydrate).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", kind: "docker" });
  });

  it("stops a resumed computer that mounts a home it chose not to download", async () => {
    const { deps, row, root, first } = await fixture();
    row.state = "suspended";
    deps.sandbox.provisionKind = async () => "desktop";
    const provisionFake = deps.sandbox.provision.bind(deps.sandbox);
    vi.spyOn(deps.sandbox, "provision").mockImplementation(async (request, ctx) => ({
      ...(await provisionFake(request, ctx)),
      kind: "docker",
    }));
    const stop = vi.spyOn(deps.sandbox, "stop");
    const destroy = vi.spyOn(deps.sandbox, "destroy");

    await expect(
      provisionComputer({ ...deps, home: objectHome(root) }, row.id, context),
    ).rejects.toThrow("Computer host changed while it was starting");
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "docker", fresh: false }),
      context,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "error", providerRef: first.providerRef });
  });

  it("fails a start whose automatic recovery mounts a home it chose not to download", async () => {
    const { deps, row, root } = await fixture();
    row.state = "suspended";
    // Host access is turned off while the damaged computer is stopped and started again.
    deps.sandbox.provisionKind = async () => "desktop";
    const provisionFake = deps.sandbox.provision.bind(deps.sandbox);
    const provision = vi
      .spyOn(deps.sandbox, "provision")
      .mockImplementationOnce(provisionFake)
      .mockImplementationOnce(async (request, ctx) => ({
        ...(await provisionFake(request, ctx)),
        kind: "docker",
      }));
    vi.spyOn(deps.sandbox, "prepare").mockRejectedValueOnce(new SandboxDamagedError());
    const stop = vi.spyOn(deps.sandbox, "stop");
    const home = objectHome(root);
    const hydrate = vi.spyOn(home, "hydrate");

    await expect(provisionComputer({ ...deps, home }, row.id, context)).rejects.toThrow(
      "Computer host changed while it was starting",
    );
    expect(provision).toHaveBeenCalledTimes(2);
    expect(hydrate).not.toHaveBeenCalled();
    expect(stop).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "docker" }), context);
    expect(row.state).toBe("error");
  });

  it("resumes a suspended computer without downloading its stored home", async () => {
    const { deps, row, root, first } = await fixture();
    row.state = "suspended";
    // The stored object cannot be read; resuming the provider's own disk does not need it.
    const home = objectHome(root, "unreadable");
    const hydrate = vi.spyOn(home, "hydrate");
    const provision = vi.spyOn(deps.sandbox, "provision");

    const resumed = await provisionComputer({ ...deps, home }, row.id, context);

    expect(provision).toHaveBeenCalledOnce();
    expect(hydrate).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(resumed, "notes.txt", context)),
    ).toBe("live work");
  });

  it("downloads the stored home only when a replacement restores it", async () => {
    const { deps, row, root, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.state = "suspended";
    const home = objectHome(root);
    await home.writeFile("bot", "notes.txt", "saved", context);
    await home.evictCache("bot");
    const hydrate = vi.spyOn(home, "hydrate");
    const provision = vi.spyOn(deps.sandbox, "provision");

    const replaced = await provisionComputer({ ...deps, home }, row.id, context);

    expect(replaced.fresh).toBe(true);
    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate.mock.invocationCallOrder[0]).toBeGreaterThan(
      provision.mock.invocationCallOrder[0]!,
    );
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(replaced, "notes.txt", context)),
    ).toBe("saved");
  });

  it("blocks competing maintenance and boots while an update owns the computer", async () => {
    const { deps, row } = await fixture();
    row.maintenanceId = "other-update";
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    for (const mode of ["update", "recover", "reset"] as const) {
      await expect(replaceComputer(deps, row.id, mode, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("claims a running computer before concurrent workers can create competing replacements", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    // Both workers read the original row before either claims it; later reads
    // (claim stamp, activation) must see the live row so updatedAt fencing works.
    const original = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return { ...original };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const results = await Promise.allSettled([
      provisionComputer(deps, row.id, context),
      provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
    expect(provision).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(row.providerRef).toBe(successful[0]?.value.providerRef);
    expect(row.state).toBe("running");
  });

  it("rejects a delayed reconnect whose original reference was already replaced", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    const stale = { ...row };
    const winner = await provisionComputer(deps, row.id, context);
    await deps.sandbox.writeFile(
      winner,
      { path: "notes.txt", content: new TextEncoder().encode("winner work") },
      context,
    );
    computer.findUniqueOrThrow.mockResolvedValue(stale);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(winner.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(winner, "notes.txt", context)),
    ).toBe("winner work");
  });

  it("claims an abandoned booting computer only once when callers have no screenLeaseId", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "booting";
    row.providerRef = null;
    const observed = { ...row };
    let reads = 0;
    computer.findUniqueOrThrow.mockImplementation(async () => {
      reads += 1;
      // First two reads are the concurrent observations before either claims.
      if (reads <= 2) return { ...observed };
      return { ...row };
    });
    const provision = vi.spyOn(deps.sandbox, "provision");
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      const results = await Promise.allSettled([
        provisionComputer(deps, row.id, context),
        provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
      expect(provision).toHaveBeenCalledOnce();
      expect(row.state).toBe("running");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves the reference and workspace through an uncertain reconnect and a retry", async () => {
    const { deps, row, first } = await fixture();
    const error = new Error("fetch failed");
    // The provider cannot confirm the computer runs, so each attempt reconnects.
    vi.spyOn(deps.sandbox as FakeSandboxProvider, "isRunning").mockResolvedValue(false);
    vi.spyOn(deps.sandbox, "provision").mockRejectedValueOnce(error);
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(error);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(restore).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each(["error", "stopped", "suspended"])(
    "reconnects desktop files after an adapter restart from %s without importing an old checkpoint",
    async (state) => {
      const { deps, row, root, first } = await fixture("desktop");
      row.state = state;
      deps.sandbox = new DesktopSandboxProvider({ root });
      const restore = vi.spyOn(deps.sandbox, "importWorkspace");
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(restore).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("live work");
    },
  );

  it("reuses a running desktop computer another process started without revoking its screens", async () => {
    const { deps, row, root, computer, first } = await fixture("desktop");
    deps.sandbox = new DesktopSandboxProvider({ root });
    const provision = vi.spyOn(deps.sandbox, "provision");

    const reused = await provisionComputer(deps, row.id, context);

    expect(provision).not.toHaveBeenCalled();
    expect(reused.providerRef).toBe(first.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reused, "notes.txt", context)),
    ).toBe("live work");
    expect(computer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: "booting" }) }),
    );
    expect(row.state).toBe("running");
  });

  it.each(["retained", "restarted"])(
    "restores the checkpoint when a desktop workspace is actually absent with a %s provider",
    async (provider) => {
      const { deps, row, root, first } = await fixture("desktop");
      expect(first.fresh).toBe(true);
      await rm(first.providerRef, { recursive: true });
      if (provider === "restarted") deps.sandbox = new DesktopSandboxProvider({ root });
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: true });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("checkpoint");
    },
  );

  it.each([
    "Path notes.txt not found",
    "404: file not found",
    "command not found",
    "checkpoint directory does not exist",
    "export process killed",
    "ECONNRESET",
  ])("aborts update and its retry when checkpoint fails with %s", async (message) => {
    const { deps, row, first } = await fixture();
    const error = new Error(message);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw error;
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(error);
      expect(row).toMatchObject({
        state: "running",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("continues update from the last revision when checkpoint finds the sandbox gone", async () => {
    const { deps, row } = await fixture();
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw Object.assign(new Error("Sandbox not found"), { name: "SandboxNotFoundError" });
    });
    const updated = await replaceComputer(deps, row.id, "update", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each(["running", "error"])(
    "updates a %s computer only after saving its current workspace",
    async (state) => {
      const { deps, row } = await fixture();
      row.state = state;
      const updated = await replaceComputer(deps, row.id, "update", context);
      expect(updated.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it("resets a computer stuck suspending after a hung stop", async () => {
    const { deps, row } = await fixture();
    row.state = "suspending";
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("refuses Reset while a suspend claim is still live", async () => {
    const { deps, row, computer } = await fixture();
    row.state = "suspending";
    row.updatedAt = new Date();
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(computer.updateMany).not.toHaveBeenCalled();
    expect(row.state).toBe("suspending");
  });

  it("resets a missing computer after idempotent provider teardown", async () => {
    const { deps, row, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the reference when reset teardown fails ambiguously", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("404: configuration file not found");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBe(failure);
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(first.providerRef);
  });

  it("saves live work before recovering a computer whose update failed while saving", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("workspace export failed");
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementationOnce(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw failure;
    });
    await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(failure);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });

    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(recovered, "notes.txt", context)),
    ).toBe("live work");
  });

  it("keeps a computer running when its update is interrupted before teardown", async () => {
    const { deps, row, first } = await fixture();
    const interrupted = new Error("Computer update interrupted");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(
      replaceComputer(deps, row.id, "update", context, "none", async (stage) => {
        if (stage === "recreating") throw interrupted;
      }),
    ).rejects.toBe(interrupted);
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
  });

  it("stops Recover instead of skipping its save when saving cannot be reported", async () => {
    const { deps, row, first } = await fixture();
    const blip = new Error("database unavailable");
    const exportWorkspace = vi.spyOn(deps.sandbox, "exportWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(
      replaceComputer(deps, row.id, "recover", context, "none", async (stage) => {
        if (stage === "saving") throw blip;
      }),
    ).rejects.toBe(blip);
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
  });

  it("stops Recover instead of rebuilding when its save cannot be recorded", async () => {
    const { deps, row, first, computer } = await fixture();
    const blip = new Error("database unavailable");
    const record = computer.updateMany.getMockImplementation()!;
    computer.updateMany.mockImplementation(async (args) => {
      if ("homeRevision" in args.data) throw blip;
      return record(args);
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(blip);
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
  });

  it("records nothing for a save Recover skipped", async () => {
    const { deps, row, computer } = await fixture();
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementationOnce(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw new Error("export process killed");
    });
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
    for (const [args] of computer.updateMany.mock.calls) {
      expect(args.data).not.toHaveProperty("homeRevisionAt");
    }
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it("stops Recover instead of rebuilding when it cannot store the exported files", async () => {
    const { deps, row, first } = await fixture();
    const blip = new Error("object storage unavailable");
    vi.spyOn(deps.home, "commit").mockRejectedValueOnce(blip);
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(blip);
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
  });

  it("stops a replacement whose save another writer overtook", async () => {
    const { deps, row, first, computer } = await fixture();
    const record = computer.updateMany.getMockImplementation()!;
    computer.updateMany.mockImplementation(async (args) =>
      "homeRevision" in args.data ? { count: 0 } : record(args),
    );
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
  });

  it("stops Recover instead of rebuilding when it cannot look up deleted bots' folders", async () => {
    const { deps, row, first } = await fixture();
    row.scope = "team";
    const blip = new Error("database unavailable");
    Object.assign(deps.prisma, {
      botDeletion: { findMany: vi.fn().mockRejectedValue(blip) },
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(blip);
    expect(destroy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
  });

  it("records an error when an update fails once teardown has started", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("sandbox destroy failed: 500");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValueOnce(failure);
    await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(failure);
    expect(row).toMatchObject({ state: "error", providerRef: first.providerRef });
  });

  it("keeps the reference for a retry when Recover cannot delete the old sandbox", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("sandbox destroy failed: 500");
    const destroy = vi.spyOn(deps.sandbox, "destroy").mockRejectedValueOnce(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "recover", context)).rejects.toBe(failure);
    expect(provision).not.toHaveBeenCalled();
    expect(row).toMatchObject({ state: "error", providerRef: first.providerRef });

    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
  });

  it("recovers past teardown of a sandbox the provider reports gone", async () => {
    const { deps, row } = await fixture();
    const gone = Object.assign(new Error("gone"), { name: "SandboxNotFoundError" });
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(gone);
    const provision = vi.spyOn(deps.sandbox, "provision");
    const recovered = await replaceComputer(deps, row.id, "recover", context);
    expect(provision).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ state: "running", providerRef: recovered.providerRef });
  });
});
