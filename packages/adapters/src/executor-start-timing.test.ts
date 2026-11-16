import type * as DbModule from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { ComputerBusyError } from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const leases = vi.hoisted(() => ({
  acquire: vi.fn(),
  dedicated: vi.fn(),
  release: vi.fn(),
}));

const settleTakeoverCards = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  settleReleasedTakeoverCards: settleTakeoverCards,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: leases.acquire,
  acquireDedicatedScreenLeaseFence: leases.dedicated,
  releaseComputerExecutionLease: leases.release,
}));

const lease = {
  computerId: "computer-1",
  botId: "bot-1",
  runId: "run-1",
  fence: 1,
};
const sink = createTestSink();

function fixture(
  options: {
    stoppingSignal?: AbortSignal;
    startedAt?: Date;
    switching?: boolean;
    dedicated?: boolean;
    heldBy?: string;
    checkpoint?: string;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    status: "queued",
    leaseFence: 0,
    checkpoint: options.checkpoint ?? null,
    startedAt: options.startedAt ?? null,
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => null) },
    spaceMember: { findUnique: async () => ({ id: "member-1" }) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased" })),
      updateMany: vi.fn(async (_args: { data: { startedAt?: Date } }) => ({
        count: 1,
      })),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        computerId: "computer-1",
        computerSwitching: options.switching ?? false,
        computer: { scope: options.dedicated ? "dedicated" : "team" },
      })),
    },
    computerExecutionLease: {
      findFirst: vi.fn(async () => (options.heldBy ? { id: options.heldBy } : null)),
    },
    // Stop at attempt setup so the fixture exercises only the real startup path.
    attempt: {
      create: vi.fn(async () => Promise.reject(new Error("attempt setup failed"))),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
    stoppingSignal: options.stoppingSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    prisma,
    enqueue,
    start: () => executor.continueRun("run-1", "worker-1"),
  };
}

describe("execution start timing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sink.events.length = 0;
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    leases.acquire.mockResolvedValue(lease);
    leases.release.mockResolvedValue(undefined);
  });

  afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

  it.each(["busy"])("starts model work while the computer is %s", async (state) => {
    leases.acquire.mockRejectedValue(new ComputerBusyError());
    const { prisma, enqueue, start } = fixture({ switching: state === "switching" });
    await expect(start()).rejects.toThrow("attempt setup failed");
    expect(leases.acquire).not.toHaveBeenCalled();
    expect(leases.dedicated).not.toHaveBeenCalled();
    expect(prisma.attempt.create).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sink.events.some((event) => event.message === "run.execution_started")).toBe(true);
  });

  it("requeues during a computer switch before capturing a stale computer", async () => {
    const { enqueue, start } = fixture({ switching: true });
    await expect(start()).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalled();
    expect(leases.acquire).not.toHaveBeenCalled();
  });

  it.each([undefined, new Date("2026-01-01T00:00:00Z")])(
    "stamps execution without claiming a computer and preserves the first start (%s)",
    async (startedAt) => {
      const { prisma, start } = fixture({ startedAt });
      leases.acquire.mockImplementation(async () => {
        expect(
          prisma.run.updateMany.mock.calls.every(([args]) => args.data.startedAt === undefined),
        ).toBe(true);
        expect(sink.events).toEqual([]);
        return lease;
      });
      await expect(start()).rejects.toThrow("attempt setup failed");
      expect(prisma.run.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "run-1",
          status: "running",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        data: { startedAt: startedAt ?? expect.any(Date), lateSince: undefined },
      });
      expect(sink.events.filter((event) => event.message === "run.execution_started")).toHaveLength(
        1,
      );
      expect(leases.acquire).not.toHaveBeenCalled();
      expect(leases.release).toHaveBeenCalledWith(prisma, null);
    },
  );

  it.each(["lost fence", "database error"])(
    "releases a dedicated computer if the start update encounters %s",
    async (failure) => {
      const { prisma, start } = fixture({ dedicated: true, checkpoint: "takeover" });
      leases.acquire.mockResolvedValue(null);
      leases.dedicated.mockImplementation(async () => {
        // Dedicated acquisition requires running status but must precede the timestamp.
        expect(prisma.run.updateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ data: { status: "running", computerUseStartedAt: null } }),
        );
        return lease;
      });
      prisma.run.updateMany.mockImplementation(async (args) => {
        if (!args.data.startedAt) return { count: 1 };
        if (failure === "database error") throw new Error("database unavailable");
        return { count: 0 };
      });
      if (failure === "database error") {
        // The failed setup is recorded as an attempt, and this fixture's attempt write fails too.
        await expect(start()).rejects.toThrow("attempt setup failed");
        expect(prisma.attempt.create).toHaveBeenCalledOnce();
      } else {
        await start();
        expect(prisma.attempt.create).not.toHaveBeenCalled();
      }
      expect(leases.release).toHaveBeenCalledWith(prisma, lease);
      expect(sink.events.some((event) => event.message === "run.execution_started")).toBe(false);
    },
  );
});

it("reuses the attempt a failed write already committed, adding no second row", async () => {
  const { prisma, start } = fixture({});
  leases.acquire.mockResolvedValue(lease);
  prisma.attempt.findFirst.mockResolvedValue({ id: "attempt-1" });
  // What follows the claim is outside this fixture; only the attempt rows matter here.
  await start().catch(() => undefined);
  expect(prisma.attempt.findFirst).toHaveBeenCalledWith({
    where: { runId: "run-1", fence: expect.any(Number) },
  });
  expect(prisma.attempt.create).toHaveBeenCalledOnce();
});

it("claims nothing when the process begins stopping while the run is being looked up", async () => {
  const stopping = new AbortController();
  const { prisma, start } = fixture({ stoppingSignal: stopping.signal });
  const run = await prisma.run.findUnique();
  prisma.run.findUnique.mockImplementation(async () => {
    stopping.abort();
    return run;
  });
  await start();
  expect(prisma.run.updateMany).not.toHaveBeenCalled();
  expect(leases.acquire).not.toHaveBeenCalled();
});

it("stops a superseded claim before it settles the new attempt's takeover cards", async () => {
  vi.clearAllMocks();
  settleTakeoverCards.mockRejectedValue(new RunHistoryWriteError());
  const { prisma, start } = fixture({ checkpoint: "takeover-skipped" });
  await start();
  expect(settleTakeoverCards).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({ runId: "run-1", lease: { owner: "worker-1", fence: 1 } }),
    expect.any(Function),
  );
  expect(leases.acquire).not.toHaveBeenCalled();
  expect(prisma.attempt.create).not.toHaveBeenCalled();
});
