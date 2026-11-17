import { createRouterClient, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { screenLeaseIdForRun } from "@rakazo/adapters";
import type { Actor, Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { botIntroPrompt } from "../router.js";
import type { RouterHandler } from "../router-test-support.js";
import {
  createRouter,
  enqueueBotIntroRun,
  handle,
  mainRole,
  withModelRoles,
} from "../router-test-support.js";
import { handleRpcError } from "../rpc-errors.js";

afterEach(() => {
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_USER;
});

describe("bot intro run", () => {
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const bot = { id: "bot-1", threadId: "thread-1" } as unknown as Bot;

  function introDeps(
    options: { agentRuntime?: string; hasCredential?: boolean; existingRun?: boolean } = {},
  ) {
    let calls = 0;
    const create = vi.fn(({ data }: { data: object }) => {
      calls += 1;
      return Promise.resolve({ id: `record-${calls}`, ...data });
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      task: { create },
      run: {
        create,
        findFirst: vi.fn().mockResolvedValue(options.existingRun ? { id: "run-0" } : null),
      },
    };
    const hasCredential = options.hasCredential ?? true;
    const preference = hasCredential
      ? { modelId: "model-1", credential: { id: "cred-1", provider: "test" } }
      : null;
    const userModelPreference = { findFirst: vi.fn().mockResolvedValue(preference) };
    const deps = {
      prisma: {
        $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
        userModelPreference,
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        user: { findUnique: vi.fn().mockResolvedValue({ name: "Ada Lovelace" }) },
        space: {
          findUnique: vi.fn().mockResolvedValue({ name: "Personal", isDefault: true }),
        },
      },
      jobs: { enqueue },
      env: { agentRuntime: options.agentRuntime ?? "pi" },
    } as unknown as RouterDeps;
    withModelRoles(
      deps.prisma,
      hasCredential ? [mainRole({ userId: "user-1" }, "test", "model-1")] : [],
    );
    return { create, enqueue, deps };
  }

  it("queues an invisible-prompt run so the bot asks what it is for", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "space-1",
          botId: "bot-1",
          threadId: "thread-1",
          userId: "user-1",
          status: "queued",
        }),
      }),
    );
    const [taskCall, runCall] = create.mock.calls as Array<
      [{ data: { prompt?: string; trigger?: string; taskId?: string } }]
    >;
    expect(taskCall?.[0].data.prompt).toBe(
      botIntroPrompt({ userName: "Ada Lovelace", spaceName: null, disabledBuiltinTools: [] }),
    );
    expect(runCall?.[0].data.trigger).toBe("created");
    // The Run must reference the Task this same call created, not a stale or
    // mismatched id, and the enqueued job must target that Run.
    expect(runCall?.[0].data.taskId).toBe("record-1");
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: { runId: "record-2" } }),
    );
    // The intro locks the thread row, which snapshot reads hold for up to 15s.
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("leaves a placeholder account name out of the intro", async () => {
    const { create, deps } = introDeps();
    vi.mocked(deps.prisma.user.findUnique).mockResolvedValue({
      name: "__PrbLMrkR__",
    } as never);

    await enqueueBotIntroRun(deps, actor, bot);

    const [taskCall] = create.mock.calls as Array<[{ data: { prompt?: string } }]>;
    expect(taskCall?.[0].data.prompt).toBe(
      botIntroPrompt({ userName: "", spaceName: null, disabledBuiltinTools: [] }),
    );
  });

  it("does nothing when the bot has no thread", async () => {
    const { create, enqueue, deps } = introDeps();

    await enqueueBotIntroRun(deps, actor, { id: "bot-1", threadId: null } as unknown as Bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing on the scripted test/eval runtime", async () => {
    const { create, enqueue, deps } = introDeps({ agentRuntime: "scripted" });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when no model is configured yet", async () => {
    const { create, enqueue, deps } = introDeps({ hasCredential: false });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not queue a second intro when an idempotent create returns an existing bot", async () => {
    const { create, enqueue, deps } = introDeps({ existingRun: true });

    await enqueueBotIntroRun(deps, actor, bot);

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("names only the intro tools the bot still has", () => {
    const prompt = (disabledBuiltinTools: string[]) =>
      botIntroPrompt({ userName: "Ada", spaceName: null, disabledBuiltinTools });
    expect(prompt([])).toContain("ask_user");
    expect(prompt([])).toContain("update_bot");
    expect(prompt(["ask_user", "update_bot"])).not.toContain("ask_user");
    expect(prompt(["ask_user", "update_bot"])).not.toContain("update_bot");
  });
});

describe("group restore with archived bots", () => {
  function fixture(archivedBots: Array<{ id: string; computerId: string | null }>, inUse = 0) {
    const bot = { update: vi.fn(async () => ({})) };
    const chatGroup = { update: vi.fn(async () => ({})) };
    const tx = {
      bot,
      chatGroup,
      chatGroupMember: {
        findMany: vi.fn(async () =>
          archivedBots.map(({ id, computerId }) => ({
            bot: { id, computer: computerId ? { id: computerId, userId: "user-1" } : null },
          })),
        ),
      },
      computer: {
        count: vi.fn(async (args: { where: { id?: string } }) => (args.where.id ? 0 : inUse)),
      },
      $queryRaw: vi.fn(async () => [{ id: "group-1", lock: "1" }]),
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
    };
    const handler = new RPCHandler(
      createRouter({ prisma, env: { sandboxProvider: "fake" } } as unknown as RouterDeps),
      {
        // As the app does, so a domain error answers with its own status.
        clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
      },
    );
    const call = async () =>
      handle(
        handler,
        new Request("http://rakazo.test/rpc/groups/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { groupId: "group-1" } }),
        }),
        {
          prefix: "/rpc",
          context: {
            actor: {
              spaceId: "space-1",
              userId: "user-1",
              email: "user@example.test",
              isDeploymentOwner: true,
            },
          },
        },
      );
    return { tx, call };
  }

  it("brings the group's archived bots back before the group, so it can be opened again", async () => {
    const { tx, call } = fixture([
      { id: "bot-a", computerId: "computer-a" },
      { id: "bot-b", computerId: null },
    ]);
    const response = await call();
    expect(response.status).toBe(200);
    expect(tx.bot.update.mock.calls).toEqual([
      [{ where: { id: "bot-a" }, data: { archivedAt: null } }],
      [{ where: { id: "bot-b" }, data: { archivedAt: null } }],
    ]);
    expect(tx.chatGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: { archivedAt: null },
    });
    expect(tx.chatGroup.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.bot.update.mock.invocationCallOrder[1]!,
    );
  });

  it("refuses with the quota error and restores nothing when a bot's computer has no room", async () => {
    process.env.SANDBOX_MAX_COMPUTERS_PER_USER = "1";
    const { tx, call } = fixture([{ id: "bot-a", computerId: "computer-a" }], 1);
    const response = await call();
    expect(response.status).toBe(400);
    expect(tx.bot.update).not.toHaveBeenCalled();
    expect(tx.chatGroup.update).not.toHaveBeenCalled();
  });
});

describe("groups.archive", () => {
  async function archiveGroup(archivedAt: Date | null) {
    const calls: string[] = [];
    const groupUpdate = vi.fn();
    // As in production: the run's computer is known only through its execution lease.
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      message: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          archivedAt,
          thread: { id: "thread-1" },
        }),
        update: groupUpdate,
      },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      secret: { deleteMany: vi.fn() },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3 },
          ]),
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: {
        findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
          where.id
            ? [{ id: "computer-1", homeKey: "home-1", kind: "docker", providerRef: "computer-1" }]
            : [],
        ),
        updateMany: vi.fn(),
      },
      event: { deleteMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: {
        updateMany: vi.fn(async () => {
          calls.push("expire lease");
        }),
      },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const releaseScreen = vi.fn(async () => {
      calls.push("release screen");
    });
    const execute = vi.fn(() => {
      calls.push("cancel run work");
      return [];
    });
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
      sandbox: { releaseScreen, execute },
      jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const response = await handle(
      new RPCHandler(createRouter(deps)),
      new Request("http://127.0.0.1/rpc/groups/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId: "group-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, releaseScreen, calls, groupUpdate };
  }

  it("stops each member's run work and releases its screen before expiring the lease", async () => {
    const { response, releaseScreen, calls } = await archiveGroup(null);

    expect(response?.status).toBe(200);
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });

  it("finishes teardown when the group is already archived and a lease is still live", async () => {
    const { response, releaseScreen, calls, groupUpdate } = await archiveGroup(
      new Date("2026-09-26T00:00:00.000Z"),
    );

    expect(response?.status).toBe(200);
    expect(groupUpdate).not.toHaveBeenCalled();
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(calls).toEqual(["cancel run work", "release screen", "expire lease"]);
  });
});

describe("groups.remove", () => {
  it("cancels the group's runs, then stops their work and expires their leases once deleted", async () => {
    const calls: string[] = [];
    // As in production: the run's computer is known only through its execution lease.
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      message: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        findUnique: vi.fn().mockResolvedValue({ id: "thread-1", historyCompactionGeneration: 3 }),
      },
      chatGroup: {
        findUnique: vi.fn().mockResolvedValue({
          artifacts: [],
          members: [{ botId: "bot-1" }],
        }),
        delete: vi.fn(async () => {
          calls.push("delete group");
        }),
      },
      run: {
        findMany: vi.fn(async (args: { distinct?: string[] }) =>
          args.distinct ? [{ botId: "past-bot" }] : [{ id: "run-1", taskId: "task-1" }],
        ),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          calls.push("cancel run");
          return where.id.in.map((id) => ({ id }));
        }),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      // No page in the group had a link, so there are no tokens to delete.
      page: { updateMany: vi.fn(async () => ({ count: 0 })) },
      secret: { findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      computerExecutionLease: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3 },
          ]),
      },
      computer: {
        findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
          where.id
            ? [{ id: "computer-1", homeKey: "home-1", kind: "docker", providerRef: "computer-1" }]
            : [],
        ),
      },
    };
    const leaseUpdate = vi.fn(async () => {
      calls.push("expire lease");
    });
    const prisma = {
      run: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      computerExecutionLease: { updateMany: leaseUpdate },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const releaseScreen = vi.fn(async () => {
      calls.push("release screen");
    });
    const execute = vi.fn(() => {
      calls.push("cancel run work");
      return [];
    });
    const purgeHistory = vi.fn(async (_request: { botId: string }) => ({
      ok: true as const,
      value: undefined,
    }));
    const deps = {
      prisma,
      memoryProviders: {
        resolve: async () => ({
          provider: { describe: () => ({ capabilities: { purgesByThread: true } }), purgeHistory },
          defaultScope: "isolated",
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
      sandbox: { releaseScreen, execute },
      jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
      artifacts: { remove: vi.fn() },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const response = await handle(
      new RPCHandler(createRouter(deps)),
      new Request("http://127.0.0.1/rpc/groups/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId: "group-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response?.status).toBe(200);
    expect(
      purgeHistory.mock.calls.map(([request]) => (request as { botId: string }).botId).sort(),
    ).toEqual(["bot-1", "past-bot"]);
    expect(purgeHistory).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", generations: [2, 3] }),
      expect.any(Object),
    );
    expect(purgeHistory.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.chatGroup.delete.mock.invocationCallOrder[0]!,
    );
    expect(releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      expect.objectContaining({
        botId: "bot-1",
        runId: "run-1",
        screenLeaseId: screenLeaseIdForRun({ runId: "run-1", fence: 3 }, "run-1"),
        cancelRunWork: true,
      }),
    );
    expect(leaseUpdate).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(calls).toEqual([
      "cancel run",
      "delete group",
      "cancel run work",
      "release screen",
      "expire lease",
    ]);
  });

  it("still removes the deleted group's files and page link secrets when expiring its leases fails", async () => {
    const tx = {
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      message: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group-1" }]),
      thread: {
        findUnique: vi.fn().mockResolvedValue({ id: "thread-1", historyCompactionGeneration: 3 }),
      },
      chatGroup: {
        findUnique: vi.fn().mockResolvedValue({
          artifacts: [{ storageKey: "artifacts/group-1/report.pdf" }],
          members: [{ botId: "bot-1" }],
        }),
        delete: vi.fn(async () => undefined),
      },
      run: {
        findMany: vi.fn(async (args: { distinct?: string[] }) =>
          args.distinct ? [{ botId: "past-bot" }] : [{ id: "run-1", taskId: "task-1" }],
        ),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({ id })),
        ),
      },
      attempt: { updateMany: vi.fn() },
      task: { updateMany: vi.fn() },
      page: { updateMany: vi.fn(async () => ({ count: 1 })) },
      secret: {
        findMany: vi.fn(async () => [{ id: "secret-1", ciphertext: "vault-ref-1" }]),
        deleteMany: vi.fn(),
      },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      computer: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      // The group is already gone when this fails, so a retry could no longer find these.
      computerExecutionLease: {
        updateMany: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
      computer: { updateMany: vi.fn() },
    } as unknown as PrismaClient;
    const removeArtifact = vi.fn(async () => undefined);
    const deleteSecret = vi.fn(async () => undefined);
    const deps = {
      prisma,
      memoryProviders: { resolve: async () => null },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
      sandbox: { releaseScreen: vi.fn(), execute: vi.fn(() => []) },
      jobs: { cancel: vi.fn().mockResolvedValue(undefined) },
      artifacts: { remove: removeArtifact },
      secrets: { delete: deleteSecret },
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const response = await handle(
      new RPCHandler(createRouter(deps)),
      new Request("http://127.0.0.1/rpc/groups/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { groupId: "group-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response?.status).toBe(500);
    expect(tx.chatGroup.delete).toHaveBeenCalled();
    expect(removeArtifact).toHaveBeenCalledWith(
      "artifacts/group-1/report.pdf",
      expect.objectContaining({ botId: "bot-1" }),
    );
    expect(deleteSecret).toHaveBeenCalledWith(
      "vault-ref-1",
      expect.objectContaining({ recordId: "secret-1" }),
    );
  });
});

describe("boards.rename", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function boardRow(ticketPrefix = "RAK") {
    return {
      id: "board-1",
      spaceId: "workspace-1",
      name: "Personal",
      ticketPrefix,
      nextNumber: 2,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
  }

  function renameDeps(tickets: number, ticketPrefix = "RAK") {
    const count = vi.fn(async () => tickets);
    const applied = ({ data }: { data: { name?: string; ticketPrefix?: string } }) => ({
      ...boardRow(ticketPrefix),
      ...data,
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    const update = vi.fn(applied);
    const updateManyAndReturn = vi.fn(
      async (args: { data: { name?: string; ticketPrefix?: string } }) => [applied(args)],
    );
    const prisma = {
      board: {
        findUnique: vi.fn(async () => boardRow(ticketPrefix)),
        update,
        updateManyAndReturn,
      },
      ticket: { count },
      user: { findUnique: vi.fn(async () => ({ labs: ["board"] })) },
    } as unknown as PrismaClient;
    const deps = { prisma, env: {} } as unknown as RouterDeps;
    return { count, update, updateManyAndReturn, handler: new RPCHandler(createRouter(deps)) };
  }

  async function rename(handler: RouterHandler, body: unknown) {
    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/boards/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("rejects a prefix change after tickets exist", async () => {
    const { count, update, updateManyAndReturn, handler } = renameDeps(2);
    const response = await rename(handler, { ticketPrefix: "OPS" });
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Cannot change the ticket prefix once tickets exist.",
      }),
    });
    expect(count).toHaveBeenCalledWith({
      where: { boardId: "board-1", spaceId: "workspace-1" },
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("changes the prefix while the board has no tickets", async () => {
    const { count, update, updateManyAndReturn, handler } = renameDeps(0);
    const response = await rename(handler, { ticketPrefix: "OPS" });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({ ticketPrefix: "OPS" }),
    });
    expect(count).toHaveBeenCalledWith({
      where: { boardId: "board-1", spaceId: "workspace-1" },
    });
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: "board-1",
        spaceId: "workspace-1",
        nextNumber: 2,
        tickets: { none: {} },
      },
      data: { ticketPrefix: "OPS" },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects the prefix change when a ticket lands between the count and the write", async () => {
    const { count, update, updateManyAndReturn, handler } = renameDeps(0);
    updateManyAndReturn.mockResolvedValueOnce([]);
    const response = await rename(handler, { name: "Launch", ticketPrefix: "OPS" });
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Cannot change the ticket prefix once tickets exist.",
      }),
    });
    expect(count).toHaveBeenCalledTimes(1);
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: "board-1",
        spaceId: "workspace-1",
        nextNumber: 2,
        tickets: { none: {} },
      },
      data: { name: "Launch", ticketPrefix: "OPS" },
    });
    // The conditional write matched nothing, so no unconditional retry may
    // apply the name change either.
    expect(update).not.toHaveBeenCalled();
    expect(updateManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it("keeps the normal update path when the prefix only differs in case", async () => {
    const { count, update, updateManyAndReturn, handler } = renameDeps(2);
    const response = await rename(handler, { ticketPrefix: "rak" });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({ ticketPrefix: "RAK" }),
    });
    expect(count).not.toHaveBeenCalled();
    // The case-only request rewrites nothing, so the write must not replay the
    // observed prefix over one a concurrent rename may have committed.
    expect(update).toHaveBeenCalledWith({
      where: { id: "board-1" },
      data: {},
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("renames the board without changing the prefix", async () => {
    const { count, update, updateManyAndReturn, handler } = renameDeps(2);
    const response = await rename(handler, { name: "Launch" });
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      json: expect.objectContaining({ name: "Launch", ticketPrefix: "RAK" }),
    });
    expect(count).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "board-1" },
      data: { name: "Launch" },
    });
    expect(updateManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("boards.tickets.list", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;

  function listDeps() {
    type TextMatch = { contains: string };
    type Where = { OR?: Array<{ title?: TextMatch; description?: TextMatch }> };
    const findMany = vi.fn(async (_args: { where: Where }) => []);
    const prisma = {
      board: {
        findUnique: vi.fn(async () => ({
          id: "board-1",
          spaceId: "workspace-1",
          name: "Personal",
          ticketPrefix: "RAK",
          nextNumber: 2,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        })),
      },
      ticket: { findMany },
      user: { findUnique: vi.fn(async () => ({ labs: ["board"] })) },
    } as unknown as PrismaClient;
    const deps = { prisma, env: {} } as unknown as RouterDeps;
    return { findMany, handler: new RPCHandler(createRouter(deps)) };
  }

  it("searches ticket text for the characters the user typed, not SQL wildcards", async () => {
    const { findMany, handler } = listDeps();
    const response = await handle(
      handler,
      new Request("http://127.0.0.1/rpc/tickets/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { q: "50%_off" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response?.status).toBe(200);
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where?.OR?.[0]?.title?.contains).toBe("50\\%\\_off");
    expect(where?.OR?.[1]?.description?.contains).toBe("50\\%\\_off");
  });
});

describe("shared space bot permissions", () => {
  const actor = { userId: "user-1", spaceId: "space-1", email: "user@rakazo.test" };

  function sharedBotClient(role: string) {
    const bot = {
      id: "bot-1",
      spaceId: "space-1",
      userId: "user-2",
      archivedAt: null,
      webhookSecretId: null,
      thread: { id: "thread-1" },
      computer: null,
    };
    const prisma = {
      bot: { findFirst: vi.fn(async () => bot) },
      spaceMember: { findUnique: vi.fn(async () => ({ role })) },
    };
    const secrets = { put: vi.fn() };
    const deps = {
      prisma,
      secrets,
      env: { webOrigin: "https://example.test", inboundEmailDomain: "bots.example.test" },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), { context: { actor } as never });
    return { client, prisma, secrets };
  }

  it("keeps a bot's email address with its creator", async () => {
    const { client } = sharedBotClient("owner");
    await expect(client.bots.emailAddress({ botId: "bot-1" })).resolves.toBeNull();
    await expect(
      client.bots.claimEmailAddress({ botId: "bot-1", name: "scout" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets only the bot's creator or the space owner delete a bot for good", async () => {
    const { client, prisma } = sharedBotClient("member");
    await expect(
      client.bots.remove({ botId: "bot-1", deleteMemories: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prisma.spaceMember.findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space-1", userId: "user-1" } },
      select: { role: true },
    });
  });

  it("keeps a bot's webhook secret with its creator", async () => {
    const { client, secrets } = sharedBotClient("owner");
    await expect(client.bots.rotateWebhookSecret({ botId: "bot-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(secrets.put).not.toHaveBeenCalled();
  });
});
