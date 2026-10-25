import { RPCHandler } from "@orpc/server/fetch";
import type * as Adapters from "@rakazo/adapters";
import { ComputerBusyError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const lifecycle = vi.hoisted(() => ({
  acquireComputerExecutionLease: vi.fn(),
  provisionComputer: vi.fn(),
  releaseComputerExecutionLease: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  acquireComputerExecutionLease: lifecycle.acquireComputerExecutionLease,
  provisionComputer: lifecycle.provisionComputer,
  releaseComputerExecutionLease: lifecycle.releaseComputerExecutionLease,
}));

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

function routerDeps(prisma: PrismaClient) {
  return {
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

async function boot(prisma: PrismaClient) {
  const handler = new RPCHandler(createRouter(routerDeps(prisma)));
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
  it("waits for a finished run to let go of the computer", async () => {
    lifecycle.acquireComputerExecutionLease
      .mockRejectedValueOnce(new ComputerBusyError())
      .mockResolvedValueOnce(null);
    lifecycle.provisionComputer.mockRejectedValue(new Error("stop after the lease"));
    const prisma = {
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

  it("reports a computer removed while the boot waited as not found", async () => {
    lifecycle.provisionComputer.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No record was found for a query.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );
    const prisma = {
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
});
