import { describe, expect, it } from "vitest";
import {
  appContract,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  CreateBotInput,
  CreateGroupInput,
  canReactToThreadMessage,
  McpServerConfigInput,
  MessageBlock,
  ModelOAuthBeginSchema,
  normalizeCreateBotProfile,
  ProductEventType,
  ReorderBotsInput,
  RunActivityRowSchema,
  RunSchema,
  UpdateBotInput,
  UpdateGroupInput,
} from "./index.js";

describe("contracts", () => {
  it("accepts optional persisted duration only on valid steps blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "steps",
        steps: [{ label: "Run tests", count: 1 }],
        durationMs: 103_000,
      }),
    ).toMatchObject({ durationMs: 103_000 });
    expect(MessageBlock.safeParse({ kind: "steps", steps: [], durationMs: -1 }).success).toBe(
      false,
    );
  });

  it("limits reactions to persisted non-channel messages", () => {
    expect(
      canReactToThreadMessage({ id: "message-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(true);
    expect(
      canReactToThreadMessage({ id: "subagent:agent-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(false);
    expect(
      canReactToThreadMessage({
        id: "message-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "channel-1",
            fromAddress: "+15555550100",
            fromLabel: "Pat",
            text: "hi",
          },
        ],
      }),
    ).toBe(false);
  });

  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("normalizes bot creation fields without losing the longer instruction copy", () => {
    const profile = normalizeCreateBotProfile({
      name: `  ${"N".repeat(100)}  `,
      title: `  ${"T".repeat(BOT_TITLE_MAX_LENGTH + 10)}  `,
      description: `  ${"D".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 10)}  `,
    });

    expect(profile.name).toHaveLength(80);
    expect(profile.title).toHaveLength(BOT_TITLE_MAX_LENGTH);
    expect(profile.description).toHaveLength(BOT_DESCRIPTION_MAX_LENGTH);
    expect(profile.instructions).toHaveLength(BOT_INSTRUCTIONS_MAX_LENGTH);
  });

  it("accepts the same title limit when creating and updating bots", () => {
    const title = "T".repeat(BOT_TITLE_MAX_LENGTH);
    expect(CreateBotInput.safeParse({ name: "Chief", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title: `${title}T` }).success).toBe(false);
  });

  it("normalizes bot names and rejects whitespace-only values at the contract boundary", () => {
    expect(CreateBotInput.parse({ name: "  Chief  " }).name).toBe("Chief");
    expect(UpdateBotInput.parse({ botId: "bot-1", name: "  Atlas  " }).name).toBe("Atlas");
    expect(CreateBotInput.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "   " }).success).toBe(false);
  });

  it("rejects partial model override clears on bot update", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelId: null }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null, modelId: null }).success,
    ).toBe(true);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        modelProvider: "xai",
        modelId: "grok-4.6",
      }).success,
    ).toBe(true);
  });

  it("normalizes group names and rejects duplicate members", () => {
    expect(CreateGroupInput.parse({ name: "  Draft team  ", botIds: ["bot-1", "bot-2"] })).toEqual({
      name: "Draft team",
      botIds: ["bot-1", "bot-2"],
    });
    expect(CreateGroupInput.safeParse({ name: "   ", botIds: ["bot-1", "bot-2"] }).success).toBe(
      false,
    );
    expect(
      UpdateGroupInput.safeParse({ groupId: "group-1", botIds: ["bot-1", "bot-1"] }).success,
    ).toBe(false);
  });

  it("keeps model OAuth start results mode-specific", () => {
    const shared = {
      loginId: "login-1",
      provider: "anthropic",
      verificationUri: "https://example.com/authorize",
      expiresInSeconds: 900,
    };
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "auth-url" }).success).toBe(true);
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code" }).success).toBe(false);
    expect(
      ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code", userCode: "ABCD-1234" })
        .success,
    ).toBe(true);
    expect(
      ModelOAuthBeginSchema.safeParse({
        ...shared,
        mode: "auth-url",
        verificationUri: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.bootstrap).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.reorder).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.botSections.list).toBeTruthy();
    expect(appContract.botSections.create).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.voice.prepare).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.cleared");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("requires a distinct, non-empty bot order", () => {
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-2", "bot-1"] }).success).toBe(true);
    expect(ReorderBotsInput.safeParse({ botIds: [] }).success).toBe(false);
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-1", "bot-1"] }).success).toBe(false);
  });

  it("accepts bot-to-bot runs in thread snapshots and activity rows", () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "bot_message",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(
      RunActivityRowSchema.safeParse({
        runId: run.id,
        botId: run.botId,
        botName: "Researcher",
        groupId: null,
        groupName: null,
        threadId: run.threadId,
        status: run.status,
        trigger: run.trigger,
        notificationsEnabled: true,
        promptSnippet: "Review the report",
        updatedAt: "2026-08-26T00:00:01.000Z",
      }).success,
    ).toBe(true);
    expect(RunSchema.safeParse({ ...run, trigger: "webhook" }).success).toBe(true);
  });

  it("caps remote MCP headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`X-Test-${index}`, "value"]),
    );
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(false);
  });

  it("allows localhost HTTP MCP endpoints and rejects other non-HTTPS URLs before storage", () => {
    const base = {
      slug: "demo",
      name: "Demo",
      transport: "streamable_http" as const,
      headers: {},
    };
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://127.0.0.1:3000/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp" })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp#" })
        .success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://example.test/mcp" }).success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "https://mcp.example.test/mcp" }).success,
    ).toBe(true);
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});
