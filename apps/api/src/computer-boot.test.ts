import { RPCHandler } from "@orpc/server/fetch";
import type * as Adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const lifecycle = vi.hoisted(() => ({
  provisionComputer: vi.fn(),
  releaseComputerExecutionLease: vi.fn(),
}));

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  acquireComputerExecutionLease: vi.fn().mockResolvedValue(null),
  provisionComputer: lifecycle.provisionComputer,
  releaseComputerExecutionLease: lifecycle.releaseComputerExecutionLease,
}));

describe("computer boot", () => {
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
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: { id: "computer-1", state: "booting", providerRef: null, scope: "team" },
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
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
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { response } = await handler.handle(
      new Request("https://api.example.test/rpc/computer/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response?.status).toBe(404);
    expect(lifecycle.provisionComputer).toHaveBeenCalledOnce();
    expect(lifecycle.releaseComputerExecutionLease).toHaveBeenCalledOnce();
  });
});
