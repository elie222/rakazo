import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import {
  ComputerBusyError,
  ComputerRecoveryRequiredError,
  sandboxStoppedError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const lifecycle = vi.hoisted(() => ({
  realAcquire: undefined as typeof Adapters.acquireComputerExecutionLease | undefined,
  acquireComputerExecutionLease: vi.fn(),
  provisionComputer: vi.fn(),
  releaseComputerExecutionLease: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (original) => {
  const adapters = await original<typeof Adapters>();
  lifecycle.realAcquire = adapters.acquireComputerExecutionLease;
  return {
    ...adapters,
    acquireComputerExecutionLease: lifecycle.acquireComputerExecutionLease,
    provisionComputer: lifecycle.provisionComputer,
    releaseComputerExecutionLease: lifecycle.releaseComputerExecutionLease,
  };
});

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

function routerDeps(prisma: PrismaClient, extra: Partial<RouterDeps> = {}) {
  return {
    ...extra,
    prisma,
    jobs: { enqueue: vi.fn() },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "https://web.example.test",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
}

async function boot(prisma: PrismaClient, extra: Partial<RouterDeps> = {}) {
  const handler = new RPCHandler(createRouter(routerDeps(prisma, extra)), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
  const { response } = await handler.handle(
    new Request("https://api.example.test/rpc/computer/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot-1" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  return response;
}

const stoppedBot = {
  id: "bot-1",
  thread: { id: "thread-1" },
  computer: { id: "computer-1", state: "stopped", providerRef: null, scope: "team" },
};

beforeEach(() => {
  lifecycle.acquireComputerExecutionLease.mockReset().mockResolvedValue(null);
  lifecycle.provisionComputer.mockReset();
  lifecycle.releaseComputerExecutionLease.mockReset();
});

describe("computer boot", () => {
  it.each([false, true])("uses claimless lease acquisition when busy=%s", async (busy) => {
    lifecycle.acquireComputerExecutionLease.mockImplementation(lifecycle.realAcquire!);
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the lease"));
    const tx = {
      computer: { findUniqueOrThrow: vi.fn().mockResolvedValue(stoppedBot.computer) },
      computerExecutionLease: {
        updateManyAndReturn: vi.fn().mockResolvedValue([]),
        create: busy
          ? vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))
          : vi.fn().mockResolvedValue({ fence: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    };
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      ...tx,
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(tx.computerExecutionLease.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          computerId: "computer-1",
          botId: "bot-1",
          OR: [{ expiresAt: { lt: expect.any(Date) } }],
        },
      }),
    );
    if (busy) {
      expect(response?.status).toBe(409);
      expect(lifecycle.provisionComputer).not.toHaveBeenCalled();
    } else {
      expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
      expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ runId: expect.stringMatching(/^boot:/), fence: 1 }),
      );
    }
  });

  it("waits for a finished run to let go of the computer", async () => {
    lifecycle.acquireComputerExecutionLease
      .mockRejectedValueOnce(new ComputerBusyError())
      .mockResolvedValueOnce(null);
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the lease"));
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "completed" }) },
    } as unknown as PrismaClient;

    await boot(prisma);

    expect(prisma.computerExecutionLease.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computerId_botId: { computerId: "computer-1", botId: "bot-1" } },
      }),
    );
    expect(lifecycle.acquireComputerExecutionLease).toHaveBeenCalledTimes(2);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
  });

  it("still refuses a boot while the run is going", async () => {
    lifecycle.acquireComputerExecutionLease.mockRejectedValue(new ComputerBusyError());
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
      computerExecutionLease: {
        findUnique: vi.fn().mockResolvedValue({
          runId: "run-1",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(409);
    expect(lifecycle.acquireComputerExecutionLease).toHaveBeenCalledOnce();
    expect(lifecycle.provisionComputer).not.toHaveBeenCalled();
  });

  it("starts a computer its provider paused by itself while it was recorded running", async () => {
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the start"));
    const running = {
      ...stoppedBot,
      computer: {
        ...stoppedBot.computer,
        state: "running",
        providerRef: "box-1",
        kind: "instabox",
        spaceId: "workspace-1",
        controlLeaseId: null,
        runningSince: new Date("2026-11-14T05:50:27Z"),
      },
    };
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: {
        findFirst: vi.fn().mockResolvedValue(running),
        findMany: vi.fn().mockResolvedValue([]),
      },
      computer: { updateMany },
      computerRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    } as unknown as PrismaClient;
    const sandbox = {
      // The provider's answer for a computer it paused on its own: it keeps its disk.
      execute: vi.fn(() => {
        throw sandboxStoppedError("instabox computer is paused; start it before using it");
      }),
    };

    await boot(prisma, {
      sandbox,
      events: { append: vi.fn(), draftRecordingsOfLease: vi.fn(async () => []) },
    } as unknown as Partial<RouterDeps>);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "computer-1",
          providerRef: "box-1",
          state: "running",
        }),
        data: expect.objectContaining({ state: "suspended" }),
      }),
    );
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
  });

  it("reports a computer removed while the boot waited as not found", async () => {
    lifecycle.provisionComputer.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No record was found for a query.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...stoppedBot,
          computer: { ...stoppedBot.computer, state: "booting" },
        }),
      },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(404);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });

  it("returns the quarantine recovery instruction over RPC without starting the computer", async () => {
    const error = new ComputerRecoveryRequiredError();
    lifecycle.provisionComputer.mockRejectedValue(error);
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          ...stoppedBot,
          computer: { ...stoppedBot.computer, state: "quarantined" },
        }),
      },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain(error.message);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });

  it("tells the user to recover a computer that stays damaged after its automatic recovery", async () => {
    lifecycle.provisionComputer.mockRejectedValue(new SandboxDamagedError());
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: { findFirst: vi.fn().mockResolvedValue(stoppedBot) },
    } as unknown as PrismaClient;

    const response = await boot(prisma);

    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("Recover the computer to rebuild it.");
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });
});

describe("computer stop", () => {
  async function stopDamaged(stop: ReturnType<typeof vi.fn>) {
    const computer = {
      id: "computer-1",
      state: "running",
      providerRef: "boat-1",
      kind: "boat",
      homeKey: "home-1",
      scope: "dedicated",
      controlLeaseId: null,
    };
    const prisma = {
      spaceMember: { count: vi.fn(async () => 1) },
      bot: { findFirst: vi.fn().mockResolvedValue({ ...stoppedBot, computer }) },
      computer: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(computer),
        findFirst: vi
          .fn()
          .mockResolvedValue({ state: "running", restorePending: false, screenGeneration: 0 }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      computerExecutionLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn(),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      computerRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaClient;
    const sandbox = {
      // biome-ignore lint/correctness/useYield: the damaged computer fails before its first file
      exportWorkspace: async function* () {
        throw new SandboxDamagedError();
      },
      stop,
    };
    const deps = {
      ...routerDeps(prisma),
      sandbox,
      home: {},
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
    } as unknown as RouterDeps;
    const { response } = await new RPCHandler(createRouter(deps)).handle(
      new Request("https://api.example.test/rpc/computer/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, prisma };
  }

  it("stops a damaged computer and records it stopped", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const { response, prisma } = await stopDamaged(stop);

    expect(response?.status).toBe(200);
    expect(stop).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      discardUnsaved: true,
    });
    expect(prisma.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", state: "suspending", providerRef: "boat-1", kind: "boat" },
      data: expect.objectContaining({ state: "stopped" }),
    });
    expect(prisma.computerRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endReason: "stopped" }) }),
    );
    expect(prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { computerId: "computer-1", botId: "bot-1" },
      data: { expiresAt: new Date(0) },
    });
    expect(prisma.computerExecutionLease.deleteMany).not.toHaveBeenCalled();
  });

  it("marks a damaged computer whose stop fails as errored", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("Boat refused the stop"));
    const { response, prisma } = await stopDamaged(stop);

    expect(response?.status).toBe(500);
    expect(stop).toHaveBeenCalledOnce();
    expect(prisma.computer.updateMany).toHaveBeenLastCalledWith({
      where: { id: "computer-1", state: "suspending" },
      data: { state: "error" },
    });
    expect(prisma.computer.update).not.toHaveBeenCalled();
  });
});
