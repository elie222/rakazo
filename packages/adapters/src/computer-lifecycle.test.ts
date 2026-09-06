import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { clearThread, type PrismaClient, type ThreadEvents } from "@rakazo/db";
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
  spaceId: "workspace-1",
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
    const computerRow = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "cloud",
      scope: "dedicated",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...computerRow })),
        updateMany: vi.fn(async (args) => {
          const result = await updateMany(args);
          if (result.count === 1) {
            Object.assign(
              computerRow,
              { updatedAt: new Date(computerRow.updatedAt.getTime() + 1) },
              args.data,
            );
          }
          return result;
        }),
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
      expect(prisma.computer.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            id: "computer-1",
            state: "booting",
            updatedAt: expect.any(Date),
            providerRef: "provider-1",
            kind: "cloud",
            bots: { some: { id: "bot-1", archivedAt: null } },
          },
        }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim abandoned booting when a live foreign lease exists", async () => {
    // Live foreign lease present: Prisma matches the booting reclaim only when the where
    // requires no live leases (heldByNobodyElse(null)). Returning count:0 for any expiresAt
    // filter would ignore a missing expiresAt.gt and a missing NOT for the caller's own lease.
    function matchesLiveLeasePredicate(
      none: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } } | undefined,
      own?: { runId: string; fence: number },
    ) {
      const gt = none?.expiresAt?.gt;
      if (!(gt instanceof Date)) return false;
      if (!own) return none?.NOT == null;
      return none?.NOT?.runId === own.runId && none?.NOT?.fence === own.fence;
    }

    const updateMany = vi.fn().mockImplementation(
      async (args: {
        where: {
          state?: string;
          updatedAt?: Date;
          executionLeases?: {
            none?: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } };
          };
        };
      }) => {
        if (args.where.state !== "booting") return { count: 1 };
        const none = args.where.executionLeases?.none;
        // Simulate a live foreign lease: only a correct "no other live lease" predicate fails the claim.
        return { count: matchesLiveLeasePredicate(none) ? 0 : 1 };
      },
    );
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };

    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(provisionComputer(deps, "computer-1", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "booting",
          updatedAt: row.updatedAt,
          executionLeases: { none: { expiresAt: { gt: expect.any(Date) } } },
        }),
      }),
    );

    updateMany.mockClear();
    updateMany.mockImplementation(
      async (args: {
        where: {
          state?: string;
          executionLeases?: {
            none?: { expiresAt?: { gt?: unknown }; NOT?: { runId?: string; fence?: number } };
          };
        };
      }) => {
        if (args.where.state !== "booting") return { count: 1 };
        const none = args.where.executionLeases?.none;
        return {
          count: matchesLiveLeasePredicate(none, { runId: "run-1", fence: 3 }) ? 0 : 1,
        };
      },
    );
    const setTimeoutReal2 = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal2(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(
        provisionComputer(deps, "computer-1", {
          ...context,
          screenLeaseId: "run-1:3",
        }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "booting",
          updatedAt: row.updatedAt,
          executionLeases: {
            none: {
              expiresAt: { gt: expect.any(Date) },
              NOT: { runId: "run-1", fence: 3 },
            },
          },
        }),
      }),
    );
  });

  it("rejects booting discovered only after waiting on suspending", async () => {
    const updateMany = vi.fn();
    const rowSuspending = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "suspending",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const rowBooting = {
      ...rowSuspending,
      state: "booting",
      updatedAt: new Date("2024-01-01T00:00:01.000Z"),
    };
    let reads = 0;
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => {
          reads += 1;
          // First read is suspending; wait loop then observes another caller's booting claim.
          return reads === 1 ? { ...rowSuspending } : { ...rowBooting };
        }),
        updateMany,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    };
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);
    try {
      await expect(provisionComputer(deps, "computer-1", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      expect(updateMany).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not adopt a concurrent reclaim stamp after claiming", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-claim-stamp-race-"));
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
        return { count: 1 };
      },
    );
    const findUniqueOrThrow = vi.fn(async () => ({ ...row }));
    const prisma = {
      computer: { findUniqueOrThrow, updateMany },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const claimData = updateMany.mock.calls[0]?.[0]?.data as { updatedAt?: Date };
      const activationWhere = updateMany.mock.calls[1]?.[0]?.where as { updatedAt?: Date };
      expect(claimData.updatedAt).toBeInstanceOf(Date);
      expect(activationWhere.updatedAt).toEqual(claimData.updatedAt);
      // Stamp must come from the claim write, not a follow-up read that a concurrent reclaim could win.
      expect(findUniqueOrThrow).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("advances the claim stamp past the observed updatedAt when the clock does not move", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-claim-stamp-skew-"));
    const observed = new Date("2024-01-01T00:00:00.000Z");
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      updatedAt: observed,
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    );
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      executionLease: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    // First Date.now() is the stale-claim check (must see the stamp as abandoned);
    // later calls freeze at the observed ms so the claim stamp still advances by +1.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(observed.getTime() + 10_000)
      .mockReturnValue(observed.getTime());
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        context,
      );
      const claim = updateMany.mock.calls[0]?.[0] as {
        where: { updatedAt?: Date };
        data: { updatedAt?: Date };
      };
      const activationWhere = updateMany.mock.calls[1]?.[0]?.where as { updatedAt?: Date };
      expect(claim.where.updatedAt).toEqual(observed);
      expect(claim.data.updatedAt?.getTime()).toBe(observed.getTime() + 1);
      expect(activationWhere.updatedAt).toEqual(claim.data.updatedAt);
      expect(row.state).toBe("running");
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a fresh booting claim after the boot wait", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-fresh-boot-claim-"));
    const nowMs = Date.parse("2024-06-01T12:00:00.000Z");
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "dedicated",
      state: "booting",
      controlLeaseId: null,
      // Claim stamp is "now" — still inside the boot-wait window, so not abandoned.
      updatedAt: new Date(nowMs),
    };
    const updateMany = vi.fn();
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
      executionLease: {
        findFirst: vi.fn(async () => null),
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const setTimeoutReal = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((fn: (...args: never[]) => void, _ms?: number, ...args: never[]) =>
      setTimeoutReal(fn, 0, ...args)) as unknown as typeof setTimeout);

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      expect(updateMany).not.toHaveBeenCalled();
      expect(row.state).toBe("booting");
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("activates a boot even if another Team bot takes a lease mid-provision", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-team-lease-mid-boot-"));
    const row = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: null as string | null,
      kind: "cloud",
      scope: "team",
      state: "stopped",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
          (key) => !(key in where) || where[key] === row[key as keyof typeof row],
        );
        if (!matches) return { count: 0 };
        Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
        return { count: 1 };
      },
    );
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const sandbox = new FakeSandboxProvider();
    const destroy = vi.spyOn(sandbox, "destroy");

    try {
      const ref = await provisionComputer(
        {
          prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir,
        },
        "computer-1",
        { ...context, screenLeaseId: "run-1:1" },
      );
      expect(ref.providerRef).toBeTruthy();
      expect(row.state).toBe("running");
      // Activation must not require "no other live lease" — a concurrent Team lease mid-boot
      // would otherwise block activation and the failure write, wedging the row in "booting".
      expect(updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.not.objectContaining({
            executionLeases: expect.anything(),
          }),
        }),
      );
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { stage: "prepare", rollbackFails: false },
    { stage: "restore", rollbackFails: false },
    { stage: "record", rollbackFails: false },
    { stage: "restore", rollbackFails: true },
  ])(
    "preserves the original computer when reconnect $stage fails (rollbackFails=$rollbackFails)",
    async ({ stage, rollbackFails }) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reconnect-rollback-"));
      const failure = new Error(`${stage} failed`);
      const rollbackError = new Error("replacement deletion failed");
      const original = {
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "box",
        scope: "dedicated",
        state: "running",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const ref = {
        id: "provider-2",
        botId: "bot-1",
        kind: "e2b" as const,
        providerRef: "provider-2",
        fresh: true,
      };
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue(original),
          updateMany:
            stage === "record"
              ? vi
                  .fn()
                  .mockResolvedValueOnce({ count: 1 })
                  .mockRejectedValueOnce(failure)
                  .mockResolvedValue({ count: 1 })
              : vi.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as PrismaClient;
      const sandbox = {
        provision: vi.fn().mockResolvedValue(ref),
        prepare: stage === "prepare" ? vi.fn().mockRejectedValue(failure) : vi.fn(),
        importWorkspace: stage === "restore" ? vi.fn().mockRejectedValue(failure) : vi.fn(),
        releaseScreen: vi.fn().mockResolvedValue(undefined),
        destroy: rollbackFails ? vi.fn().mockRejectedValue(rollbackError) : vi.fn(),
        stop: vi.fn(),
      } as unknown as SandboxProvider;

      try {
        const result = provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        );
        if (rollbackFails) {
          await expect(result).rejects.toMatchObject({ errors: [failure, rollbackError] });
        } else {
          await expect(result).rejects.toBe(failure);
        }
        expect(sandbox.releaseScreen).toHaveBeenCalledExactlyOnceWith(ref, context);
        expect(sandbox.destroy).toHaveBeenCalledExactlyOnceWith(ref, context);
        expect(sandbox.stop).not.toHaveBeenCalled();
        expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
          where: {
            id: "computer-1",
            state: "booting",
            providerRef: "provider-1",
            kind: "box",
            updatedAt: expect.any(Date),
          },
          data: { state: "running" },
        });
        expect(original).toMatchObject({
          state: "running",
          kind: "box",
          providerRef: "provider-1",
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("does not stop a pre-existing computer when reconnect setup fails", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reconnect-unowned-"));
    const failure = new Error("prepare failed");
    const original = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "box",
      scope: "dedicated",
      state: "running",
      controlLeaseId: null,
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const ref = {
      id: "provider-2",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "provider-2",
      fresh: false,
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(original),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const sandbox = {
      provision: vi.fn().mockResolvedValue(ref),
      prepare: vi.fn().mockRejectedValue(failure),
      importWorkspace: vi.fn(),
      releaseScreen: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      stop: vi.fn(),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: new LocalAgentHomeStore(dataDir),
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).rejects.toBe(failure);
      expect(sandbox.stop).not.toHaveBeenCalled();
      expect(sandbox.destroy).not.toHaveBeenCalled();
      expect(prisma.computer.update).not.toHaveBeenCalled();
      expect(prisma.computer.updateMany).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: "e2b" as const, providerRef: "provider-2", fresh: true },
    { kind: "box" as const, providerRef: "provider-2", fresh: false },
    { kind: "e2b" as const, providerRef: "provider-1", fresh: false },
    { kind: "box" as const, providerRef: "provider-1", fresh: true },
  ])(
    "restores saved files before reconnecting to $kind/$providerRef (fresh=$fresh)",
    async (next) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-reconnect-update-"));
      const home = new LocalAgentHomeStore(dataDir);
      const sandbox = new FakeSandboxProvider();
      const ref = {
        ...(await sandbox.provision({ botId: "bot-1", homePath: dataDir }, context)),
        ...next,
      };
      vi.spyOn(sandbox, "provision").mockResolvedValue(ref);
      const prepare = vi.spyOn(sandbox, "prepare");
      const destroy = vi.spyOn(sandbox, "destroy");
      const stop = vi.spyOn(sandbox, "stop");
      const saved = new TextEncoder().encode("saved work");
      const prisma = {
        computer: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: "computer-1",
            homeKey: "bot-1",
            providerRef: "provider-1",
            kind: "box",
            scope: "dedicated",
            state: "running",
            controlLeaseId: null,
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany: vi
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockImplementation(async () => {
              expect(await sandbox.readFile(ref, "notes/keep.txt", context)).toEqual(saved);
              return { count: 1 };
            }),
        },
      } as unknown as PrismaClient;

      try {
        await home.writeFile("bot-1", "notes/keep.txt", "saved work", context);
        await expect(
          provisionComputer(
            {
              prisma,
              sandbox,
              home,
              jobs: {} as JobPublisher,
              events: {} as ThreadEvents,
              dataDir,
            },
            "computer-1",
            context,
          ),
        ).resolves.toEqual(ref);
        expect(prepare).toHaveBeenCalledWith(ref, context);
        expect(await sandbox.readFile(ref, "notes/keep.txt", context)).toEqual(saved);
        expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
          where: {
            id: "computer-1",
            state: "booting",
            providerRef: "provider-1",
            kind: "box",
            updatedAt: expect.any(Date),
            bots: { some: { id: "bot-1", archivedAt: null } },
          },
          data: { state: "running", providerRef: next.providerRef, kind: next.kind },
        });
        expect(destroy).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
        where: {
          id: "computer-1",
          state: "booting",
          providerRef: null,
          kind: "e2b",
          updatedAt: expect.any(Date),
        },
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

  it.each([false, true])(
    "preserves a running computer's files on ordinary reconnect (prepare fails=%s)",
    async (prepareFails) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-provision-reconnect-"));
      const ref = {
        id: "provider-1",
        botId: "bot-1",
        kind: "cloud" as const,
        providerRef: "provider-1",
        fresh: false,
      };
      const prepare = prepareFails
        ? vi.fn().mockRejectedValue(new Error("provider preparation failed"))
        : vi.fn().mockResolvedValue(undefined);
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
            updatedAt: new Date("2024-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
      } as unknown as PrismaClient;
      const sandbox = {
        provision: vi.fn().mockResolvedValue(ref),
        prepare,
        importWorkspace: vi.fn(),
        destroy: vi.fn(),
        stop: vi.fn(),
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
        if (prepareFails) {
          await expect(result).rejects.toThrow("provider preparation failed");
        } else {
          await expect(result).resolves.toEqual(ref);
        }
        expect(prepare).toHaveBeenCalledWith(ref, context);
        expect(sandbox.importWorkspace).not.toHaveBeenCalled();
        expect(sandbox.destroy).not.toHaveBeenCalled();
        expect(sandbox.stop).not.toHaveBeenCalled();
        expect(prisma.computer.updateMany).toHaveBeenCalledTimes(2);
        expect(prisma.computer.update).not.toHaveBeenCalled();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
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

  it("fences one Team bot's screen and expires only the matching lease", async () => {
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
        expiresAt: { gt: new Date(0) },
      },
      data: { expiresAt: expect.any(Date) },
    });
    await releaseComputerExecutionLease(prisma.client, lease);
    expect(prisma.updateMany).toHaveBeenLastCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.deleteMany).not.toHaveBeenCalled();
  });

  it("does not let a late renewal resurrect a released lease", async () => {
    let expiresAt = new Date(Date.now() + 60_000);
    const create = vi.fn();
    const updateManyAndReturn = vi.fn().mockImplementation(async ({ data }) => {
      if (expiresAt >= new Date()) return [];
      expiresAt = data.expiresAt;
      return [{ fence: 2 }];
    });
    const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
      if (where.expiresAt?.gt && expiresAt <= where.expiresAt.gt) return { count: 0 };
      expiresAt = data.expiresAt;
      return { count: 1 };
    });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ scope: "team", state: "running" }),
      },
      computerExecutionLease: { create, updateMany, updateManyAndReturn },
    } as unknown as PrismaClient;
    const lease = {
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
    };

    await releaseComputerExecutionLease(prisma, lease);
    await expect(renewComputerExecutionLease(prisma, lease)).resolves.toBe(false);
    expect(expiresAt).toEqual(new Date(0));
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { ...lease, expiresAt: { gt: new Date(0) } },
      data: { expiresAt: expect.any(Date) },
    });
    await expect(
      acquireComputerExecutionLease(prisma, {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-2",
      }),
    ).resolves.toMatchObject({ runId: "run-2", fence: 2 });
    expect(create).not.toHaveBeenCalled();
  });

  it("increments the screen fence when the same Team bot starts another run", async () => {
    const prisma = leasePrisma({ scope: "team" });
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot-1", homePath: "/tmp" }, context);
    const first = await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });
    await sandbox.observe(computer, {
      ...context,
      screenLeaseId: screenLeaseIdForRun(first, "run-1"),
    });
    await releaseComputerExecutionLease(prisma.client, first);
    prisma.updateManyAndReturn.mockResolvedValueOnce([{ fence: 2 }]);

    const second = await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-2",
      botId: "bot-1",
    });
    expect(second).toEqual({
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-2",
      fence: 2,
    });
    await expect(
      sandbox.observe(computer, {
        ...context,
        screenLeaseId: screenLeaseIdForRun(second, "run-2"),
      }),
    ).resolves.toMatchObject({ activeWindow: expect.anything() });
    expect(prisma.create).toHaveBeenCalledOnce();
  });

  it("increments the screen fence after clearing a thread with an open screen", async () => {
    const sandbox = new FakeSandboxProvider();
    const computer = await sandbox.provision({ botId: "bot-1", homePath: "/tmp" }, context);
    const lease = {
      computerId: "computer-1",
      botId: "bot-1",
      runId: "run-1",
      fence: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const client = {
      thread: {
        update: vi
          .fn()
          .mockResolvedValueOnce({ nextMessageSeq: 0, historyCompactionGeneration: 0 })
          .mockResolvedValue({ nextEventSeq: 1 }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateMany: vi.fn(),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      computerExecutionLease: {
        updateMany: vi.fn().mockImplementation(async ({ data }) => {
          lease.expiresAt = data.expiresAt;
          return { count: 1 };
        }),
        updateManyAndReturn: vi.fn().mockImplementation(async ({ data }) => {
          if (lease.expiresAt >= new Date()) return [];
          lease.runId = data.runId;
          lease.expiresAt = data.expiresAt;
          lease.fence += data.fence.increment;
          return [{ fence: lease.fence }];
        }),
        create,
      },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ scope: "team", state: "running" }),
        updateMany: vi.fn(),
      },
      message: { deleteMany: vi.fn() },
      event: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({
          id: "event-1",
          spaceId: "workspace-1",
          threadId: "thread-1",
          botId: "bot-1",
          seq: 0,
          type: "thread.cleared",
          payload: {},
          runId: null,
          createdAt: new Date(),
        }),
      },
      bot: { update: vi.fn() },
    };
    const prisma = {
      ...client,
      $transaction: vi.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    } as unknown as PrismaClient;

    await sandbox.observe(computer, { ...context, screenLeaseId: "run-1:1" });
    await clearThread(prisma, {
      spaceId: "workspace-1",
      threadId: "thread-1",
      botId: "bot-1",
    });
    const next = await acquireComputerExecutionLease(prisma, {
      computerId: "computer-1",
      runId: "run-2",
      botId: "bot-1",
    });

    expect(next).toMatchObject({ runId: "run-2", fence: 2 });
    await expect(
      sandbox.observe(computer, {
        ...context,
        runId: "run-2",
        screenLeaseId: screenLeaseIdForRun(next, "run-2"),
      }),
    ).resolves.toMatchObject({ activeWindow: expect.anything() });
    expect(create).not.toHaveBeenCalled();
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
    expect(prisma.updateMany).toHaveBeenCalledWith({
      where: {
        computerId: "computer-1",
        botId: "bot-1",
        runId: "run-1",
        fence: 1,
      },
      data: { expiresAt: new Date(0) },
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
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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

  it("resets a computer a crashed worker left booting", async () => {
    // No live lease from anyone else: the worker that set "booting" is gone, so Reset must
    // reach the claim instead of answering "Computer is busy" for good.
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "dedicated",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
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
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: "booting" }) }),
    );
  });

  it("refuses a booting computer another bot is still holding", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "computer-1",
          homeKey: "bot-1",
          providerRef: "",
          kind: "fake",
          scope: "team",
          state: "booting",
          controlLeaseId: null,
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany,
      },
      computerExecutionLease: {
        findFirst: vi.fn().mockResolvedValue({ id: "lease-other-bot" }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
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
    expect(updateMany).not.toHaveBeenCalled();
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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

  it("does not treat stale user control without a lease as busy during reset", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 }) // clearInactiveUserComputerControl
      .mockResolvedValueOnce({ count: 0 }); // suspending claim races
    const findUniqueOrThrow = vi
      .fn()
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "fake",
        scope: "dedicated",
        state: "running",
        controlHolder: "user",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        controlLeaseExpiresAt: null,
        controlBotId: "bot-1",
      })
      .mockResolvedValueOnce({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: "provider-1",
        kind: "fake",
        scope: "dedicated",
        state: "running",
        controlHolder: "none",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        controlLeaseExpiresAt: null,
        controlBotId: null,
      });
    const prisma = {
      computer: {
        findUniqueOrThrow,
        updateMany,
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

    expect(updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: "computer-1", controlHolder: "user" }),
        data: expect.objectContaining({ controlHolder: "none" }),
      }),
    );
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.run.findFirst).not.toHaveBeenCalled();
  });

  it("blocks reset while expired control revocation is still in progress", async () => {
    const computer = {
      id: "computer-1",
      homeKey: "bot-1",
      providerRef: "provider-1",
      kind: "fake",
      scope: "dedicated",
      state: "running",
      controlHolder: "user",
      controlLeaseId: "lease-1",
      controlLeaseExpiresAt: new Date(Date.now() - 60_000),
      controlBotId: null,
      spaceId: "space-1",
      userId: "user-1",
    };
    const findUniqueOrThrow = vi.fn().mockResolvedValue(computer);
    const findUnique = vi.fn().mockResolvedValue(computer);
    const prisma = {
      computer: { findUniqueOrThrow, findUnique, updateMany: vi.fn() },
      run: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const sandbox = Object.assign(new FakeSandboxProvider(), {
      setScreenControl: async () => {
        throw new Error("provider unavailable");
      },
    }) as SandboxProvider;

    await expect(
      replaceComputer(
        {
          prisma,
          sandbox,
          home: {} as AgentHomeStore,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher,
          events: {} as ThreadEvents,
        },
        "computer-1",
        "reset",
        context,
      ),
    ).rejects.toThrow("computer control revocation is still in progress");
    expect(prisma.computer.updateMany).not.toHaveBeenCalled();
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      })
      .mockResolvedValue({
        id: "computer-1",
        homeKey: "bot-1",
        providerRef: null,
        kind: "fake",
        scope: "dedicated",
        state: "stopped",
        controlLeaseId: null,
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
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
