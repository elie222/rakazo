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
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
} from "./computer-lifecycle.js";

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
      expect(cleanup === "destroy" ? destroy : stop).toHaveBeenCalledWith(ref, context);
      expect(cleanup === "destroy" ? stop : destroy).not.toHaveBeenCalled();
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
  });

  it("fences Team Computer use and releases only the matching lease", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 1, fence: 7 });
    const lease = await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
    });

    expect(lease).toEqual({ computerId: "computer-1", runId: "run-1", fence: 7 });
    expect(prisma.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "computer-1",
          controlHolder: { not: "user" },
          OR: [
            { executionRunId: null },
            {
              executionLeaseExpiresAt: { lt: expect.any(Date) },
              controlHolder: { not: "user" },
            },
          ],
        }),
        data: expect.objectContaining({
          executionRunId: "run-1",
          executionBotId: "bot-1",
          executionFence: { increment: 1 },
        }),
        select: { executionFence: true },
      }),
    );

    prisma.updateMany.mockClear();
    await expect(renewComputerExecutionLease(prisma.client, lease)).resolves.toBe(true);
    expect(prisma.updateMany).toHaveBeenCalledWith({
      where: {
        id: "computer-1",
        executionRunId: "run-1",
        executionFence: 7,
        controlHolder: { not: "user" },
      },
      data: { executionLeaseExpiresAt: expect.any(Date) },
    });
    await releaseComputerExecutionLease(prisma.client, lease);
    expect(prisma.updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", executionRunId: "run-1", executionFence: 7 },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  });

  it("rejects a second Team Computer run while the lease is held", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 0 });

    await expect(
      acquireComputerExecutionLease(prisma.client, {
        computerId: "computer-1",
        runId: "run-2",
        botId: "bot-2",
      }),
    ).rejects.toThrow("Computer is busy");
  });

  it("does not reclaim an active lease from another worker on the same run", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 0 });

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
          OR: [
            { executionRunId: null },
            {
              executionLeaseExpiresAt: { lt: expect.any(Date) },
              controlHolder: { not: "user" },
            },
          ],
        }),
      }),
    );
  });

  it("only reclaims an active same-run lease when resuming a held takeover", async () => {
    const prisma = leasePrisma({ scope: "team", acquired: 1, fence: 8 });

    await acquireComputerExecutionLease(prisma.client, {
      computerId: "computer-1",
      runId: "run-1",
      botId: "bot-1",
      resumeHeldLease: true,
    });

    expect(prisma.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { executionRunId: null },
            { executionRunId: "run-1" },
            {
              executionLeaseExpiresAt: { lt: expect.any(Date) },
              controlHolder: { not: "user" },
            },
          ],
        }),
      }),
    );
  });
});

function leasePrisma(options: { scope: string; acquired?: number; fence?: number }) {
  const acquired = options.acquired ?? 1;
  const updateMany = vi.fn().mockResolvedValue({ count: acquired });
  const updateManyAndReturn = vi
    .fn()
    .mockResolvedValue(acquired === 1 ? [{ executionFence: options.fence ?? 1 }] : []);
  const computer = {
    findUniqueOrThrow: vi.fn().mockResolvedValue({ scope: options.scope }),
    updateMany,
    updateManyAndReturn,
  };
  return {
    client: { computer } as unknown as PrismaClient,
    updateMany,
    updateManyAndReturn,
  };
}
