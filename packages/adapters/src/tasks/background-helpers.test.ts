import { runContinueJob } from "@rakazo/adapter-kit";
import { settleRunSubagents } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { messagingTools } from "../runs/tools/run-tools-messaging.js";
import { fleetTools } from "../tools/builtin-fleet.tool-definition.js";
import {
  cancelBackgroundHelper,
  listBackgroundHelpers,
  returnHelperOutcome,
  startBackgroundHelper,
} from "./background-helpers.js";
import { startedNote } from "./background-helpers.prompt.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  assertRunCanWriteHistory: vi.fn(async () => undefined),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "card" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

const START = {
  name: "scout",
  task: "compare the venues",
  instructions: "",
  modelProvider: "",
  modelId: "",
  executionId: "call-1",
  effectKey: "effect-1",
};

function providerIds(provider: unknown): string[] | null {
  if (typeof provider === "string") return [provider];
  if (provider && typeof provider === "object" && "in" in provider) {
    const ids = provider.in;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
  }
  return null;
}

function harness(
  overrides: { trigger?: string; threadBotId?: string | null; providers?: string[] } = {},
) {
  const createRun = vi.fn(async (_args: unknown) => ({ id: "helper-run" }));
  const credentials = (overrides.providers ?? []).map((provider) => ({
    id: `credential-${provider}`,
    userId: "user",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultModel: null,
    thinkingLevel: null,
    userPreferences: [],
  }));
  const secrets = credentials.map((credential) => ({
    id: credential.secretId,
    ciphertext: credential.secretId,
  }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: {
      findMany: vi.fn(async (_args: unknown): Promise<{ id: string; blocks: unknown[] }[]> => []),
    },
    thread: { create: vi.fn(async () => ({ id: "helper-thread" })) },
    task: { create: vi.fn(async () => ({ id: "helper-task" })) },
    run: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: createRun,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    userModelCredential: {
      findMany: vi.fn(async (args?: { where?: { provider?: unknown } }) => {
        const ids = providerIds(args?.where?.provider);
        if (!ids) return credentials;
        return credentials.filter((row) => ids.includes(row.provider));
      }),
      findFirst: vi.fn(async (args?: { where?: { provider?: unknown } }) => {
        const ids = providerIds(args?.where?.provider);
        if (!ids) return credentials[0] ?? null;
        return credentials.find((row) => ids.includes(row.provider)) ?? null;
      }),
    },
    userModelPreference: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    secret: {
      findMany: vi.fn(async () => secrets),
      findFirst: vi.fn(async (args?: { where?: { id?: string } }) => {
        return secrets.find((secret) => secret.id === args?.where?.id) ?? null;
      }),
    },
  };
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue },
      secretStore: { load: vi.fn(async () => "fake-api-key") },
      billingEnabled: false,
    },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: overrides.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot" },
    secrets: [],
    thread: {
      id: "chat",
      botId: overrides.threadBotId === undefined ? "bot" : overrides.threadBotId,
    },
  } as unknown as RunContext;
  return { ctx, prisma, createRun, enqueue, tx };
}

describe("starting a background helper", () => {
  it("starts one from the owner's own chat and queues its run", async () => {
    const h = harness();
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "helper-thread",
        trigger: "helper",
        sourceMessageId: "card",
        status: "queued",
      }),
      select: { id: true },
    });
    expect(h.createRun.mock.calls[0]?.[0]).not.toHaveProperty("data.modelPinned");
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
    // It takes the chat's lock, which a snapshot read can hold for a while.
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("preserves the source user's attachments on the independent run", async () => {
    const h = harness();
    h.ctx.run.sourceMessageId = "user-message";
    const file = {
      kind: "file",
      artifactId: "artifact-1",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    };
    h.tx.message.findMany.mockResolvedValue([
      { id: "user-message", blocks: [{ kind: "text", text: "Summarize this" }, file] },
    ]);
    await startBackgroundHelper(h.ctx, START);
    expect(h.tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "chat",
          role: "user",
          OR: [
            { id: "user-message" },
            { steeringMessages: { some: { runId: "run-1", claimedAt: { not: null } } } },
          ],
        }),
      }),
    );
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        threadId: "helper-thread",
        runId: "helper-run",
        role: "user",
        blocks: [file],
        markUnread: false,
      }),
    );
  });

  it("keeps its card running when the turn that started it ends", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, START);
    const [, input] = vi.mocked(createThreadMessageInTransaction).mock.lastCall!;
    const [, event] = vi.mocked(appendEventInTransaction).mock.lastCall!;
    // The turn's run.completed settles that turn's helper cards on every live client.
    const card = { id: "card", runId: input.runId, blocks: input.blocks };
    expect(settleRunSubagents([card], h.ctx.runId)).toEqual([card]);
    expect(event.runId).toBeUndefined();
  });

  it.each([{ threadBotId: null }, { trigger: "messaging" }])(
    "delegates from any chat surface",
    async (overrides) => {
      const h = harness(overrides);
      await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
      expect(h.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delegatedFromRunId: "run-1",
            sourceMessageId: "card",
          }),
        }),
      );
    },
  );

  it.each([
    ["a routine", { trigger: "routine" }],
    ["another bot's request", { trigger: "bot_message" }],
    ["a helper's result coming back", { trigger: "helper_result" }],
  ])("refuses to start one from %s", async (_label, overrides) => {
    const h = harness(overrides);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("cannot delegate further"),
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("inherits a model explicitly pinned on the parent run", async () => {
    const h = harness();
    Object.assign(h.ctx.run, { modelPinned: true, modelProvider: "fixture", modelId: "pinned" });
    await startBackgroundHelper(h.ctx, START);
    expect(h.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelProvider: "fixture",
          modelId: "pinned",
          modelPinned: true,
        }),
      }),
    );
  });

  it("pins the model it was asked for, and needs both halves of it", async () => {
    const h = harness({ providers: ["opencode-go"] });
    await expect(
      startBackgroundHelper(h.ctx, {
        ...START,
        modelProvider: "opencode-go",
        modelId: "claude-haiku-5-5",
      }),
    ).resolves.toEqual({ ok: true, id: "helper-run", name: "scout", note: startedNote("scout") });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "opencode-go",
        modelId: "claude-haiku-5-5",
        modelPinned: true,
      }),
      select: { id: true },
    });
    const half = harness();
    await expect(
      startBackgroundHelper(half.ctx, { ...START, modelProvider: "openai" }),
    ).resolves.toEqual({ error: "model_provider and model_id must both be set" });
    expect(half.prisma.$transaction).not.toHaveBeenCalled();
    expect(half.createRun).not.toHaveBeenCalled();
  });

  it("run-subagent-label-prefixed-pair starts pinned to the canonical provider and model", async () => {
    const h = harness({ providers: ["opencode-go"] });
    await expect(
      startBackgroundHelper(h.ctx, {
        ...START,
        modelProvider: "OpenCode Go",
        modelId: "opencode-go/claude-haiku-5-5",
      }),
    ).resolves.toEqual({ ok: true, id: "helper-run", name: "scout", note: startedNote("scout") });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "opencode-go",
        modelId: "claude-haiku-5-5",
        modelPinned: true,
      }),
      select: { id: true },
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
  });

  it("run-subagent-label-prefixed-pair trims the tool fields before pinning the canonical model", async () => {
    // The same model id is offered by two connected providers. Only the trimmed provider id
    // selects one of them.
    const h = harness({ providers: ["opencode", "opencode-go"] });
    const call = {
      name: "run_subagent",
      args: {
        name: "scout",
        task: "compare the venues",
        model_provider: "  opencode-go  ",
        model_id: "  claude-haiku-5-5  ",
      },
      executionId: "call-1",
      effectKey: "effect-1",
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;
    await expect(messagingTools.run_subagent!(h.ctx, call)).resolves.toEqual({
      ok: true,
      id: "helper-run",
      name: "scout",
      note: startedNote("scout"),
    });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "opencode-go",
        modelId: "claude-haiku-5-5",
        modelPinned: true,
      }),
      select: { id: true },
    });
  });

  it("returns an error and starts nothing when the model pair cannot be resolved", async () => {
    const h = harness({ providers: ["opencode-go"] });
    await expect(
      startBackgroundHelper(h.ctx, {
        ...START,
        modelProvider: "not-a-provider",
        modelId: "nope",
      }),
    ).resolves.toEqual({
      error: 'No model matches "nope". The user can connect a model provider in Settings.',
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("returns the connection error and starts nothing when resolve accepts a disconnected provider", async () => {
    const h = harness({ providers: ["opencode-go"] });
    await expect(
      startBackgroundHelper(h.ctx, { ...START, modelProvider: "openai", modelId: "gpt-x" }),
    ).resolves.toEqual({ error: "Connect that model provider first" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("returns the existing helper run id on idempotent replay", async () => {
    const h = harness();
    h.tx.run.findFirst.mockResolvedValueOnce({ id: "helper-existing" } as never);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      ok: true,
      id: "helper-existing",
      name: "scout",
      note: startedNote("scout"),
    });
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("describes model_provider as a provider id and model_id as an id or provider/id", () => {
    const tool = fleetTools.find((entry) => entry.name === "run_subagent");
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        model_provider: {
          description: "Provider id (e.g. opencode-go). Set together with model_id.",
        },
        model_id: {
          description: "Model id or provider/id. Set together with model_provider.",
        },
      },
    });
  });
});

describe("returning a helper's outcome", () => {
  it("waits for the chat's lock with the thread-lock budget", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const run = { id: "helper-run", spaceId: "space", botId: "bot", userId: "user" };
    await returnHelperOutcome(
      { prisma, events: { notify: vi.fn() } } as never,
      { ...run, sourceMessageId: "card" },
      { status: "completed", text: "done" },
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });
});

describe("passing a helper's result back in a shared space", () => {
  // The bot was made by "creator"; "member" shares the space and started the helper.
  function shared(
    overrides: { member?: boolean; archived?: boolean; attachments?: unknown[] } = {},
  ) {
    const createRun = vi.fn(async (_args: unknown) => ({ id: "wake" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { updateMany: vi.fn(async () => ({ count: 1 })), create: createRun },
      message: {
        findMany: vi.fn(async () =>
          overrides.attachments ? [{ id: "helper-file", blocks: overrides.attachments }] : [],
        ),
        findFirst: vi.fn(async () => ({
          id: "card",
          threadId: "chat",
          blocks: [
            { kind: "subagent", agentId: "call-1", name: "scout", task: "t", status: "running" },
          ],
        })),
        update: vi.fn(async () => ({})),
      },
      spaceMember: {
        findUnique: vi.fn(async () => (overrides.member === false ? null : { id: "membership" })),
      },
      bot: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          overrides.archived ||
          (where.userId !== undefined && where.userId !== "creator") ||
          where.archivedAt !== null
            ? null
            : { id: "bot" },
        ),
      },
      task: { create: vi.fn(async () => ({ id: "wake-task" })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const enqueue = vi.fn(async () => undefined);
    const run = {
      id: "helper-run",
      spaceId: "space",
      botId: "bot",
      userId: "member",
      sourceMessageId: "card",
    };
    const returned = returnHelperOutcome(
      { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } } as never,
      run,
      { status: "completed", text: "found three venues" },
    );
    return { returned, createRun, enqueue };
  }

  it("returns attached files to the conversation under the result run", async () => {
    const file = {
      kind: "file",
      artifactId: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    };
    const h = shared({ attachments: [file] });
    await h.returned;
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: "chat", runId: "wake", blocks: [file] }),
    );
  });

  it("brings it back for a member who did not make the bot, as their own turn", async () => {
    const h = shared();
    await h.returned;
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "chat",
        userId: "member",
        trigger: "helper_result",
        clientNonce: "helper-result:helper-run",
      }),
      select: { id: true },
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("wake"));
  });

  it.each([
    ["the member has left the space", { member: false }],
    ["the bot is archived", { archived: true }],
  ])("only settles the card when %s", async (_label, overrides) => {
    const h = shared(overrides);
    await h.returned;
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("listing and cancelling background helpers", () => {
  type ActiveHelperRow = {
    id: string;
    status: string;
    startedAt: Date | null;
    createdAt: Date;
    sourceMessageId: string;
    sourceMessage: { id: string; blocks: unknown[] };
  };

  function makeHelper(
    overrides: Partial<{
      id: string;
      status: string;
      name: string;
      task: string;
      agentId: string;
      sourceMessageId: string;
      startedAt: Date | null;
      createdAt: Date;
    }> = {},
  ): ActiveHelperRow {
    const id = overrides.id ?? "helper-1";
    const sourceMessageId = overrides.sourceMessageId ?? `card-${id}`;
    return {
      id,
      status: overrides.status ?? "running",
      startedAt:
        overrides.startedAt === undefined
          ? new Date("2026-11-01T10:00:00.000Z")
          : overrides.startedAt,
      createdAt: overrides.createdAt ?? new Date("2026-11-01T09:59:00.000Z"),
      sourceMessageId,
      sourceMessage: {
        id: sourceMessageId,
        blocks: [
          {
            kind: "subagent",
            agentId: overrides.agentId ?? `agent-${id}`,
            name: overrides.name ?? "scout",
            task: overrides.task ?? "compare venues",
            status: "running",
          },
        ],
      },
    };
  }

  function controlHarness(
    options: {
      trigger?: string;
      conversationThreadId?: string;
      secrets?: string[];
      active?: ActiveHelperRow[];
      leases?: Array<{ computerId: string; botId: string; runId: string; fence: number }>;
      computers?: Array<{ id: string; homeKey: string; kind: string; providerRef: string | null }>;
      withSandbox?: boolean;
      pendingAskByRun?: Record<string, { id: string; blocks: unknown[] }[]>;
    } = {},
  ) {
    const active = options.active ?? [makeHelper()];
    const activeById = new Map(active.map((row) => [row.id, row]));
    const updatedMessages: Array<{ where: unknown; data: unknown }> = [];
    const execute = vi.fn(async function* () {
      yield { type: "exit" as const, code: 0 };
    });
    const releaseScreen = vi.fn(async () => undefined);
    const publishSpaceChange = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findMany: vi.fn(async (args?: { where?: { id?: { in?: string[] } } }) => {
          if (args?.where?.id?.in) {
            return args.where.id.in.map((id) => ({ id, userId: "user-1", spaceId: "space-1" }));
          }
          return active;
        }),
        updateManyAndReturn: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.flatMap((id) => {
            const row = activeById.get(id);
            return row
              ? [
                  {
                    id: row.id,
                    spaceId: "space-1",
                    botId: "bot-1",
                    userId: "user-1",
                    sourceMessageId: row.sourceMessageId,
                  },
                ]
              : [];
          }),
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      externalEffect: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      event: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      computerExecutionLease: { findMany: vi.fn(async () => options.leases ?? []) },
      computer: { findMany: vi.fn(async () => options.computers ?? []) },
      message: {
        findMany: vi.fn(async ({ where }: { where?: { runId?: unknown } }) => {
          if (typeof where?.runId === "string") {
            return options.pendingAskByRun?.[where.runId] ?? [];
          }
          return [];
        }),
        findFirst: vi.fn(async ({ where }: { where?: { id?: string } }) => {
          const match = active.find((row) => row.sourceMessageId === where?.id);
          return match
            ? {
                id: match.sourceMessageId,
                threadId: options.conversationThreadId ?? "chat-1",
                blocks: match.sourceMessage.blocks,
                thread: { group: null },
              }
            : null;
        }),
        update: vi.fn(async (args: { where: unknown; data: unknown }) => {
          updatedMessages.push(args);
          return {};
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      run: { findMany: vi.fn(async () => active) },
      message: {
        findUnique: vi.fn(async () => ({
          threadId: options.conversationThreadId ?? "chat-1",
        })),
      },
      computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const ctx = {
      deps: {
        prisma,
        events: { notify, publishSpaceChange },
        ...(options.withSandbox ? { sandbox: { execute, releaseScreen } } : {}),
      },
      run: {
        id: "run-parent",
        spaceId: "space-1",
        userId: "user-1",
        threadId: "thread-own",
        trigger: options.trigger ?? "user",
      },
      runId: "run-parent",
      bot: { id: "bot-1" },
      thread: { id: options.conversationThreadId ?? "chat-1" },
      source: {
        conversationThreadId: options.conversationThreadId,
      },
      secrets: options.secrets ?? [],
    } as unknown as RunContext;
    return { ctx, prisma, tx, execute, releaseScreen, publishSpaceChange, notify, updatedMessages };
  }

  it("lists active helpers scoped to this bot, user, space, and conversation thread with redaction", async () => {
    const h = controlHarness({
      conversationThreadId: "chat-conv",
      secrets: ["tok-secret-99"],
      active: [
        makeHelper({
          id: "helper-1",
          name: "scout tok-secret-99",
          task: "fetch using tok-secret-99",
          status: "queued",
          startedAt: null,
          createdAt: new Date("2026-11-01T09:50:00.000Z"),
        }),
        makeHelper({
          id: "helper-2",
          name: "reviewer",
          task: "check draft",
          status: "running",
          startedAt: new Date("2026-11-01T10:00:00.000Z"),
          createdAt: new Date("2026-11-01T09:55:00.000Z"),
        }),
      ],
    });
    const result = await listBackgroundHelpers(h.ctx);
    expect(result).toEqual({
      subagents: [
        {
          id: "helper-1",
          name: "scout [redacted]",
          status: "queued",
          task: "fetch using [redacted]",
          startedAt: "2026-11-01T09:50:00.000Z",
        },
        {
          id: "helper-2",
          name: "reviewer",
          status: "running",
          task: "check draft",
          startedAt: "2026-11-01T10:00:00.000Z",
        },
      ],
    });
    expect(h.prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          botId: "bot-1",
          userId: "user-1",
          trigger: "helper",
          sourceMessage: { threadId: "chat-conv" },
        }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("refuses listing and cancelling in non-conversational runs", async () => {
    const h = controlHarness({ trigger: "routine" });
    await expect(listBackgroundHelpers(h.ctx)).resolves.toEqual({
      error: expect.stringContaining("unavailable"),
    });
    await expect(cancelBackgroundHelper(h.ctx, { all: true })).resolves.toEqual({
      error: expect.stringContaining("cannot be cancelled"),
    });
    expect(h.prisma.run.findMany).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires id, name, or all: true to cancel", async () => {
    const h = controlHarness();
    await expect(cancelBackgroundHelper(h.ctx, {})).resolves.toEqual({
      error: "Pass id, name, or all: true to cancel a subagent.",
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["run id", { id: "helper-1" }],
    ["card message id", { id: "card-helper-1" }],
    ["card agentId", { id: "agent-helper-1" }],
    ["trimmed case-insensitive name", { name: "  SCOUT  " }],
  ])(
    "cancels a matching helper by %s, settles its card, denies asks, and tears down its computer",
    async (_label, input) => {
      const h = controlHarness({
        conversationThreadId: "chat-1",
        withSandbox: true,
        active: [
          makeHelper({ id: "helper-1", name: "scout", sourceMessageId: "card-helper-1" }),
          makeHelper({ id: "helper-2", name: "reviewer", sourceMessageId: "card-helper-2" }),
        ],
        leases: [{ computerId: "comp-1", botId: "bot-1", runId: "helper-1", fence: 3 }],
        computers: [{ id: "comp-1", homeKey: "home-1", kind: "fake", providerRef: "ref-1" }],
        pendingAskByRun: {
          "helper-1": [
            {
              id: "ask-1",
              blocks: [
                {
                  kind: "ask",
                  text: "Approve?",
                  status: "pending",
                  approvalEffectId: "eff-1",
                  actions: [
                    { id: "allow", label: "Allow" },
                    { id: "deny", label: "Deny" },
                  ],
                },
              ],
            },
          ],
        },
      });
      await expect(cancelBackgroundHelper(h.ctx, input)).resolves.toEqual({
        ok: true,
        cancelled: [{ id: "helper-1", name: "scout" }],
      });
      expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
      expect(h.tx.run.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ["helper-1"] } }),
          data: expect.objectContaining({ status: "cancelled", completedAt: expect.any(Date) }),
        }),
      );
      expect(h.tx.event.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ runId: { in: ["helper-1"] } }),
        }),
      );
      expect(h.publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
      // Pending ask denied + subagent card settled to failed/stopped.
      expect(h.updatedMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            where: { id: "ask-1" },
            data: { blocks: [expect.objectContaining({ status: "answered", answer: "deny" })] },
          }),
          expect.objectContaining({
            where: { id: "card-helper-1" },
            data: {
              blocks: [
                expect.objectContaining({ kind: "subagent", status: "failed", result: "stopped" }),
              ],
            },
          }),
        ]),
      );
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.releaseScreen).toHaveBeenCalledOnce();
      expect(h.prisma.computerExecutionLease.updateMany).toHaveBeenCalledWith({
        where: { runId: { in: ["helper-1"] } },
        data: { expiresAt: new Date(0) },
      });
    },
  );

  it("refuses to cancel when multiple helpers share a name without all: true", async () => {
    const h = controlHarness({
      secrets: ["secret-x"],
      active: [
        makeHelper({ id: "helper-1", name: "scout secret-x", status: "running" }),
        makeHelper({ id: "helper-2", name: "scout secret-x", status: "queued" }),
      ],
    });
    await expect(cancelBackgroundHelper(h.ctx, { name: "scout secret-x" })).resolves.toEqual({
      error: "Multiple running subagents match that name. Pass id or all: true.",
      matches: [
        { id: "helper-1", name: "scout [redacted]", status: "running" },
        { id: "helper-2", name: "scout [redacted]", status: "queued" },
      ],
    });
    expect(h.tx.run.updateManyAndReturn).not.toHaveBeenCalled();
    expect(h.publishSpaceChange).not.toHaveBeenCalled();
  });

  it("cancels all matching helpers when name and all: true are passed, and all helpers on all: true alone", async () => {
    const rows = [
      makeHelper({ id: "helper-1", name: "scout" }),
      makeHelper({ id: "helper-2", name: "scout" }),
      makeHelper({ id: "helper-3", name: "reviewer" }),
    ];
    const byName = controlHarness({ active: rows });
    await expect(cancelBackgroundHelper(byName.ctx, { name: "scout", all: true })).resolves.toEqual(
      {
        ok: true,
        cancelled: [
          { id: "helper-1", name: "scout" },
          { id: "helper-2", name: "scout" },
        ],
      },
    );
    const everything = controlHarness({ active: rows });
    await expect(cancelBackgroundHelper(everything.ctx, { all: true })).resolves.toEqual({
      ok: true,
      cancelled: [
        { id: "helper-1", name: "scout" },
        { id: "helper-2", name: "scout" },
        { id: "helper-3", name: "reviewer" },
      ],
    });
  });

  it("is idempotent when no active subagent matches", async () => {
    const h = controlHarness({ active: [makeHelper({ id: "helper-1", name: "scout" })] });
    await expect(cancelBackgroundHelper(h.ctx, { name: "other" })).resolves.toEqual({
      ok: true,
      cancelled: [],
      note: "No matching running subagents.",
    });
    expect(h.tx.run.updateManyAndReturn).not.toHaveBeenCalled();
    expect(h.publishSpaceChange).not.toHaveBeenCalled();
  });
});
