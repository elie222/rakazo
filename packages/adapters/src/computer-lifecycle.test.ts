import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  computerSupportsUpdate,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  replaceComputer,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "test",
  traceId: "test",
  workspaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("computer provisioning", () => {
  it("stops a provider when archive invalidates its boot claim", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-race-"));
    const stop = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "cloud",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue({
        id: "provider-1",
        botId: "bot-1",
        kind: "cloud",
        providerRef: "provider-1",
      }),
      prepare: vi.fn().mockResolvedValue(undefined),
      stop,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("Computer is busy");
      expect(releaseScreen).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            id: "computer-1",
            state: "booting",
            bots: { some: { id: "bot-1", archivedAt: null } },
          },
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { fresh: true, cleanup: "destroy" as const },
    { fresh: false, cleanup: "stop" as const },
  ])("rolls back $cleanup when shared preparation fails", async ({ fresh, cleanup }) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-prepare-rollback-"));
    const ref = {
      id: "provider-1",
      botId: "bot-1",
      kind: "fake" as const,
      providerRef: "provider-1",
      fresh,
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockRejectedValue(new Error("provider preparation failed"));
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: fresh ? null : "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare,
      stop,
      destroy,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("provider preparation failed");
      expect(prepare).toHaveBeenCalledWith(ref, context);
      expect(releaseScreen).toHaveBeenCalledWith(ref, context);
      expect(cleanup === "destroy" ? destroy : stop).toHaveBeenCalledWith(ref, context);
      expect(cleanup === "destroy" ? stop : destroy).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("releases the screen when activation fails on a resumed Team computer", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-activation-rollback-"));
    const ref = {
      id: "provider-1",
      botId: "team-home",
      kind: "docker" as const,
      providerRef: "provider-1",
      fresh: false,
    };
    const stop = vi.fn().mockResolvedValue(undefined);
    const releaseScreen = vi.fn().mockResolvedValue(undefined);
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "team-home",
          providerRef: "provider-1",
          kind: "docker",
          scope: "team",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(async function* () {
        yield { type: "exit", code: 0 };
      }),
      stop,
      releaseScreen,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toThrow("Computer is busy");
      expect(sandbox.execute).toHaveBeenCalled();
      expect(releaseScreen).toHaveBeenCalledWith(ref, context);
      expect(stop).toHaveBeenCalledWith(ref, context);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retains a fresh provider reference when rollback also fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-prepare-rollback-failure-"));
    const prepareError = new Error("provider preparation failed");
    const rollbackError = new Error("provider deletion failed");
    const ref = {
      id: "new-provider-1",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "new-provider-1",
      fresh: true,
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "e2b",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockRejectedValue(prepareError),
      destroy: vi.fn().mockRejectedValue(rollbackError),
    } as unknown as SandboxProvider;

    try {
      const result = provisionComputer(
        {
          prisma,
          sandbox,
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      await expect(result).rejects.toMatchObject({
        errors: [prepareError, rollbackError],
      });
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { id: "computer-1", state: "booting" },
        data: {
          state: "error",
          providerRef: "new-provider-1",
          kind: "e2b",
        },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reconnects a running computer and still prepares the provider", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-reconnect-"));
    const ref = {
      id: "provider-1",
      botId: "bot-1",
      kind: "cloud" as const,
      providerRef: "provider-1",
      fresh: false,
    };
    const prepare = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "cloud",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
        }),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare,
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).resolves.toEqual(ref);
      expect(prepare).toHaveBeenCalledWith(ref, context);
      expect(prisma.computer.updateMany).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("computer execution leases", () => {
  it("does not serialize dedicated computers", async () => {
    const prisma = leasePrisma({ scope: "dedicated" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toBeNull();
    expect(prisma.updateManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("fences one Team bot's screen and releases only the matching lease", async () => {
    const prisma = leasePrisma({ scope: "team" });
    const lease = await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });

    expect(lease).toEqual({
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
    });
    expect(prisma.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          computerId: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 1,
        }),
        select: { fence: true },
      }),
    );

    prisma.updateMany.mockClear();
    await expect(renewComputerExecutionLease(prisma.client, lease)).resolves.toBe(true);
    expect(prisma.updateMany).toHaveBeenCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
      data: { expiresAt: expect.any(Date) },
    });
    await releaseComputerExecutionLease(prisma.client, lease);
    expect(prisma.deleteMany).toHaveBeenCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
    });
  });

  it("lets two Team bots hold leases at the same time", async () => {
    const prisma = leasePrisma({ scope: "team" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).resolves.toMatchObject({ botId: "bot-1", runId: "run-1" });
    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-2",
      }),
    ).resolves.toMatchObject({ botId: "bot-2", runId: "run-2" });
    expect(prisma.create).toHaveBeenCalledTimes(2);
  });

  it("rejects a second run for the same Team bot while its lease is held", async () => {
    const prisma = leasePrisma({ scope: "team", uniqueConflict: true });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
  });

  it("does not reclaim an active lease from another worker on the same run", async () => {
    const prisma = leasePrisma({ scope: "team", uniqueConflict: true });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
    expect(prisma.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computerId: "computer-1",
          botId: "bot-1",
          OR: [{ expiresAt: { lt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it("only reclaims an active same-run lease when resuming a held takeover", async () => {
    const prisma = leasePrisma({ scope: "team", reclaim: true, fence: 8 });

    await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
      resumeHeldLease: true,
    });

    expect(prisma.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ expiresAt: { lt: expect.any(Date) } }, { runId: "run-1" }],
        }),
      }),
    );
    expect(prisma.create).not.toHaveBeenCalled();
  });

  it("keeps the screen lease on the run id and fence", () => {
    expect(screenLeaseIdForRun({ runId: "run-1", fence: 8 }, "run-1")).toBe("run-1:8");
    expect(screenLeaseIdForRun(null, "run-1", 0)).toBe("run-1:0");
  });

  it("rolls back a lease that races with computer suspension", async () => {
    const prisma = leasePrisma({ scope: "team" });
    prisma.findUniqueOrThrow
      .mockResolvedValueOnce({ scope: "team", state: "running" })
      .mockResolvedValue({ scope: "team", state: "suspending" });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-1",
        botId: "bot-1",
      }),
    ).rejects.toThrow("Computer is busy");
    expect(prisma.deleteMany).toHaveBeenCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
    });
  });
});

function leasePrisma(options: {
  scope: string;
  reclaim?: boolean;
  fence?: number;
  uniqueConflict?: boolean;
}) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const updateManyAndReturn = vi
    .fn()
    .mockResolvedValue(options.reclaim ? [{ fence: options.fence ?? 1 }] : []);
  const create = vi.fn().mockImplementation(async () => {
    if (options.uniqueConflict) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    return { fence: 1 };
  });
  const findUniqueOrThrow = vi.fn().mockResolvedValue({
    scope: options.scope,
    state: "running",
  });
  return {
    client: {
      computer: {
        findUniqueOrThrow,
      },
      computerExecutionLease: {
        updateManyAndReturn,
        create,
        updateMany,
        deleteMany,
      },
    } as unknown as PrismaClient,
    updateMany,
    updateManyAndReturn,
    create,
    deleteMany,
    findUniqueOrThrow,
  };
}

describe("computer replacement", () => {
  it("exposes update availability by sandbox kind", () => {
    expect(computerSupportsUpdate("e2b")).toBe(true);
    expect(computerSupportsUpdate("desktop")).toBe(false);
  });

  it("replaces a wedged computer and restores the durable home", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-replace-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-replace-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    await sandbox.writeFile(
      first,
      { path: "notes/keep.txt", content: new TextEncoder().encode("saved") },
      context,
    );
    const revision = await checkpointComputerWorkspace(home, sandbox, "bot-1", first, context);

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      homeRevision: revision,
    };
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce(computerRecord)
      .mockResolvedValueOnce({ ...computerRecord, state: "stopped", providerRef: null })
      .mockResolvedValue({
        ...computerRecord,
        state: "stopped",
        providerRef: null,
      });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      computer: { findUniqueOrThrow, updateMany, update },
      computerExecutionLease: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;

    const destroy = vi.spyOn(sandbox, "destroy");
    try {
      const ref = await replaceComputer(
        {
          prisma,
          sandbox,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(destroy).toHaveBeenCalledOnce();
      expect(ref.fresh).toBe(true);
      expect(new TextDecoder().decode(await sandbox.readFile(ref, "notes/keep.txt", context))).toBe(
        "saved",
      );
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    } catch (error) {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
      throw error;
    }
  });

  it("rejects replacement while another team bot holds the computer", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "running",
          controlLeaseId: null,
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "other-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement while the target bot has an active run", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlLeaseId: null,
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "same-bot-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement while any bot holds user control", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "team",
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
          controlBotId: "other-bot",
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement while the same bot holds user control", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlHolder: "user",
          controlLeaseId: "lease-1",
          controlLeaseExpiresAt: new Date(Date.now() + 60_000),
          controlBotId: "bot-1",
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
  });

  it("rejects replacement when control is claimed before the suspending lock", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "running",
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(prisma.computer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          OR: expect.arrayContaining([
            { controlHolder: { not: "user" } },
            { controlLeaseId: null },
            { controlLeaseExpiresAt: null },
            { controlLeaseExpiresAt: { lte: expect.any(Date) } },
          ]),
        }),
      }),
    );
  });

  it("rejects replacement of a stopped computer while a run is still active", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany,
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "recover",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", state: "stopped" }),
        data: { state: "suspending" },
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "computer-1", state: "suspending" },
        data: { state: "stopped" },
      }),
    );
  });

  it("rejects replacement of a suspended computer while a run is still active", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "provider-1",
          kind: "fake",
          scope: "dedicated",
          state: "suspended",
          controlLeaseId: null,
        }),
        updateMany,
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-run" }),
      },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "update",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", state: "suspended" }),
        data: { state: "suspending" },
      }),
    );
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "computer-1", state: "suspending" },
        data: { state: "suspended" },
      }),
    );
  });

  it("claims a stopped computer before teardown so concurrent replacements serialize", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-replace-stopped-claim-"));
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: null,
        kind: "fake",
        scope: "dedicated",
        state: "stopped",
        controlLeaseId: null,
      })
      .mockResolvedValue({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: null,
        kind: "fake",
        scope: "dedicated",
        state: "stopped",
        controlLeaseId: null,
      });
    const prisma = {
      computer: { findUniqueOrThrow, updateMany, update },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();

    try {
      await replaceComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ id: "computer-1", state: "stopped" }),
          data: { state: "suspending" },
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a second claim on a stopped computer that is already suspending", async () => {
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: null,
          kind: "fake",
          scope: "dedicated",
          state: "stopped",
          controlLeaseId: null,
        }),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 0 }),
      },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      replaceComputer(
        {
          prisma,
          sandbox: new FakeSandboxProvider(),
          home: {} as AgentHomeStore,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toBeInstanceOf(ComputerBusyError);
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
  });

  it("continues recover when checkpoint fails with an ordinary provider error", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-recover-checkpoint-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-recover-checkpoint-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    vi.spyOn(sandbox, "exportWorkspace").mockImplementation(() => {
      throw new Error("ECONNRESET");
    });

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      homeRevision: null,
    };
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce(computerRecord)
      .mockResolvedValue({
        ...computerRecord,
        state: "stopped",
        providerRef: null,
      });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      computer: { findUniqueOrThrow, updateMany, update },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      const ref = await replaceComputer(
        {
          prisma,
          sandbox,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        "recover",
        context,
      );
      expect(destroy).toHaveBeenCalledOnce();
      expect(ref.fresh).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });

  it("aborts update when checkpoint fails with an ordinary provider error", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-update-checkpoint-"));
    const homeRoot = await mkdtemp(path.join(tmpdir(), "rakazo-update-checkpoint-home-"));
    const home = new LocalAgentHomeStore(homeRoot);
    const sandbox = new FakeSandboxProvider();
    const first = await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context);
    vi.spyOn(sandbox, "exportWorkspace").mockImplementation(() => {
      throw new Error("ECONNRESET");
    });

    const computerRecord = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: first.providerRef,
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      homeRevision: null,
    };
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(computerRecord),
        updateMany,
        update: vi.fn(),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      await expect(
        replaceComputer(
          {
            prisma,
            sandbox,
            home,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          "update",
          context,
        ),
      ).rejects.toThrow("ECONNRESET");
      expect(destroy).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { id: "computer-1" },
        data: { state: "error" },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  });
});
