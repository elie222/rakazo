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

describe("connection completion", () => {
  it("checks the pending connection ref instead of any account for the same provider", async () => {
    const connectionReady = vi.fn().mockResolvedValue(false);
    const complete = vi.fn();
    const existing = {
      id: "connection-1",
      connectorId: "composio",
      provider: "GMAIL",
      providerRef: "ca-pending",
      displayName: "Work",
      status: "pending",
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    const prisma = {
      connection: { findFirst: vi.fn().mockResolvedValue(existing) },
      botConnectorDefault: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn().mockReturnValue({ connectionReady, complete }),
      },
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
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { connectionId: existing.id } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(connectionReady).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "connections.complete" }),
      "GMAIL",
      "ca-pending",
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("connection start", () => {
  it("does not create another authorization attempt while one is pending for the same app", async () => {
    const create = vi.fn();
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({ id: "pending-connection" }),
        create,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn().mockReturnValue({ begin: vi.fn().mockResolvedValue({ state: "ca-new" }) }),
      },
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
      new Request("http://127.0.0.1/rpc/connections/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectorId: "composio",
            provider: "googlecalendar",
            displayName: "Google Calendar",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("duplicate connection completion", () => {
  it("keeps the original active row when Composio returns an already-connected account", async () => {
    const pending = {
      id: "pending-connection",
      connectorId: "composio",
      provider: "googlecalendar",
      providerRef: "ca-new",
      displayName: "Google Calendar",
      status: "pending",
      createdAt: new Date("2026-08-24T00:00:00.000Z"),
    };
    const active = {
      ...pending,
      id: "active-connection",
      providerRef: "ca-existing",
      status: "connected",
    };
    const update = vi.fn().mockResolvedValue(pending);
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(active),
        update,
      },
      botConnectorDefault: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn().mockReturnValue({
          connectionReady: vi.fn().mockResolvedValue(true),
          complete: vi.fn().mockResolvedValue({ connectionRef: "ca-existing" }),
        }),
      },
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

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { connectionId: pending.id } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: pending.id },
      data: { status: "revoked" },
    });
  });
});
