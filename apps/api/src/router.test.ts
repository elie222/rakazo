import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("thread answer enqueue", expect.any(Error));
    logError.mockRestore();
  });
});

describe("computer.peek", () => {
  const actor = {
    workspaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function peekDeps(overrides: {
    botFindFirst?: ReturnType<typeof vi.fn>;
    leaseFindUnique?: ReturnType<typeof vi.fn>;
    connectScreen?: ReturnType<typeof vi.fn>;
  }) {
    const connectScreen =
      overrides.connectScreen ??
      vi.fn().mockResolvedValue({ url: "https://sandbox.test/vnc.html", close: async () => {} });
    const leaseFindUnique = overrides.leaseFindUnique ?? vi.fn();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      bot: { findFirst: overrides.botFindFirst ?? vi.fn().mockResolvedValue(null) },
      computerExecutionLease: { findUnique: leaseFindUnique },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return {
      deps,
      connectScreen,
      leaseFindUnique,
      enqueue,
      handler: new RPCHandler(createRouter(deps)),
    };
  }

  async function callPeek(
    handler: ReturnType<typeof peekDeps>["handler"],
    targetBotId: string,
    peekActor: Actor = actor,
  ) {
    return handler.handle(
      new Request("http://127.0.0.1/rpc/computer/peek", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { targetBotId } }),
      }),
      { prefix: "/rpc", context: { actor: peekActor } },
    );
  }

  it("fails closed for an unknown or foreign bot id", async () => {
    const { handler, connectScreen, leaseFindUnique } = peekDeps({
      botFindFirst: vi.fn().mockResolvedValue(null),
    });
    const { matched, response } = await callPeek(handler, "missing-bot");
    expect(matched).toBe(true);
    expect(response.status).not.toBe(200);
    expect(connectScreen).not.toHaveBeenCalled();
    expect(leaseFindUnique).not.toHaveBeenCalled();
  });

  it("connects the target screen without an execution lease", async () => {
    const target = {
      id: "bot-other",
      workspaceId: "workspace-1",
      userId: "user-1",
      thread: { id: "thread-other" },
      computer: {
        id: "computer-1",
        homeKey: "home-1",
        kind: "fake",
        scope: "team",
        state: "running",
        providerRef: "provider-1",
        controlHolder: "none",
        controlBotId: null,
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlRunId: null,
      },
    };
    const { handler, connectScreen, leaseFindUnique } = peekDeps({
      botFindFirst: vi.fn().mockResolvedValue(target),
      // If peek incorrectly used computerScreenContext, this lease would be attached.
      leaseFindUnique: vi.fn().mockResolvedValue({
        runId: "run-1",
        fence: 3,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });

    const { matched, response } = await callPeek(handler, target.id);
    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      json: { mode: "team", exists: true, state: "running" },
    });
    expect(typeof body.json.url).toBe("string");
    expect(connectScreen).toHaveBeenCalledOnce();
    expect(connectScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "provider-1" }),
      { view: "stream", interactive: false },
      expect.objectContaining({
        botId: "bot-other",
        operationId: "peek",
        workspaceId: "workspace-1",
        userId: "user-1",
      }),
    );
    const context = connectScreen.mock.calls[0]?.[2] as { screenLeaseId?: string };
    expect(context.screenLeaseId).toBeUndefined();
    expect(leaseFindUnique).not.toHaveBeenCalled();
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});
