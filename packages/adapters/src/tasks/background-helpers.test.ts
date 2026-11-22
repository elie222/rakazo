import { runContinueJob } from "@rakazo/adapter-kit";
import { settleRunSubagents } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolCall } from "../runs/tools/run-tool-gate.js";
import { messagingTools } from "../runs/tools/run-tools-messaging.js";
import { fleetTools } from "../tools/builtin-fleet.tool-definition.js";
import { returnHelperOutcome, startBackgroundHelper } from "./background-helpers.js";
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
    ).resolves.toEqual({ ok: true, name: "scout", note: startedNote("scout") });
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
    ).resolves.toEqual({ ok: true, name: "scout", note: startedNote("scout") });
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
    ).resolves.toEqual({ error: 'No model matches "nope".' });
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
