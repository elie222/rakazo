import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { selectContext, shortenToolResultText } from "../../runtime/context/context-selection.js";
import type { WatchDeliveryState } from "../../runtime/context/runtime-context.js";
import { createRuntimeContextPolicy } from "../../runtime/context/runtime-context.js";
import { OMITTED_AFTER_USE } from "../../runtime/context/runtime-context.prompt.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "../../runtime/pi/pi-runtime-limits.js";
import { serializeToolResult } from "../../runtime/pi/tools/pi-runtime-tools.js";
import type { RunContext } from "./run-context.js";
import { restoreTurnCheckpointEffects } from "./run-context.js";

function fixture(tools: ConnectorTool[] = []) {
  return {
    runId: "run-1",
    tools: { offered: tools },
    state: {
      effects: {
        occurrences: [],
        counts: new Map(),
        consumedIds: new Set(),
        restoredPending: undefined,
      },
    },
  } as unknown as RunContext;
}
const tool = (name: string): ConnectorTool => ({
  name,
  description: "Fixture",
  inputSchema: { type: "object" },
});
const model = { provider: "fixture", id: "main" };
function checkpoint(name: string) {
  return JSON.stringify({
    version: 1,
    provider: model.provider,
    model: model.id,
    systemPrompt: "Fixture",
    pendingToolCallId: "pending",
    executionMode: "sequential",
    messages: [
      { role: "assistant", content: [{ type: "toolCall", id: "pending", name, arguments: {} }] },
    ],
  });
}

it("keeps before-use omissions excluded when selectContext later compacts the result after use", () => {
  const details = {
    routines: [
      {
        routineId: "r-two-stage",
        prompt: "Send weekly summary to owner-prompt@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"x".repeat(4_800)} never-seen-stage1@outside.test ${"y".repeat(4_800)}`,
          entries: {
            "item-seen": `${"s".repeat(67)} seen-stage1@outside.test ${"t".repeat(67)}`,
          },
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  expect(raw.length).toBeLessThan(TOOL_RESULT_TEXT_LIMIT);

  // Stage 1 (before first use): selectContext shortens the newest tool result before the model sees it.
  const turn1 = selectContext(
    [
      { role: "user", content: "List schedules" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "two-stage-1", name: "schedule_list", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "two-stage-1",
        toolName: "schedule_list",
        content: [{ type: "text", text: raw }],
        details,
      },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      budget: { contextWindow: 2_600, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage1Msg = turn1.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage1Text = stage1Msg.content[0]?.text ?? "";
  expect(stage1Text).not.toContain("never-seen-stage1@outside.test");
  expect(stage1Text).toContain("seen-stage1@outside.test");
  expect(stage1Msg.details?.contextBeforeUseText).toBe(stage1Text);

  // Stage 2 (after use): a later assistant turn arrives and selectContext compacts the same result further.
  const turn2 = selectContext(
    [
      ...turn1.messages,
      { role: "assistant", content: [{ type: "text", text: "Checked schedules." }] },
      { role: "user", content: `Continue ${"c".repeat(40)}` },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      protectedIndexes: [1, 2],
      budget: {
        contextWindow: turn1.estimatedInputTokens + 10,
        outputReserve: 0,
        systemPrompt: "Fixture",
        tools: [],
      },
    },
  );
  const stage2Msg = turn2.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage2Text = stage2Msg.content[0]?.text ?? "";
  expect(stage2Text).not.toContain("never-seen-stage1@outside.test");
  expect(stage2Text).not.toContain("seen-stage1@outside.test");
  expect(stage2Text).toContain(OMITTED_AFTER_USE);
  expect(stage2Msg.details?.contextBeforeUseText).toBe(stage1Text);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(stage2Msg);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).not.toContain("never-seen-stage1@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-prompt@example.test");
  expect(ctx.state.outsideText).toContain("seen-stage1@outside.test");
});

it("keeps plain-text before-use cuts bounded across later after-use compaction", () => {
  const details = {
    routines: [
      {
        routineId: "r-plain-two-stage",
        prompt: "Forward digest to owner-plain-two-stage@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `hdr\nvisible-before-use@outside.test ${"a".repeat(6_000)} omitted-before-use@outside.test ${"b".repeat(6_000)} tail-end`,
        },
      },
    ],
  };
  const clipped = clipToolResultText(serializeToolResult(details, "current", "schedule_list", {}));
  expect(() => JSON.parse(clipped)).toThrow();
  expect(clipped).toContain("visible-before-use@outside.test");
  expect(clipped).toContain("omitted-before-use@outside.test");

  // Stage 1 (before first use): selectContext shortens the clipped plain-text result and records it.
  const turn1 = selectContext(
    [
      { role: "user", content: "List schedules" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "plain-two-stage", name: "schedule_list", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "plain-two-stage",
        toolName: "schedule_list",
        content: [{ type: "text", text: clipped }],
        details,
      },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      budget: { contextWindow: 3_600, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage1Msg = turn1.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage1Text = stage1Msg.content[0]?.text ?? "";
  expect(stage1Text).toContain("visible-before-use@outside.test");
  expect(stage1Text).not.toContain("omitted-before-use@outside.test");
  expect(stage1Msg.details?.contextBeforeUseText).toBe(stage1Text);

  // Stage 2 (after use): a later turn compacts the result further, dropping visible-before-use from text.
  const turn2 = selectContext(
    [
      ...turn1.messages,
      { role: "assistant", content: [{ type: "text", text: "Checked schedules." }] },
      { role: "user", content: "Continue" },
    ],
    {
      strategy: "cache-aware",
      truncateToolResults: true,
      protectedIndexes: [1, 2],
      budget: { contextWindow: 300, outputReserve: 0, systemPrompt: "Fixture", tools: [] },
    },
  );
  const stage2Msg = turn2.messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  };
  const stage2Text = stage2Msg.content[0]?.text ?? "";
  expect(stage2Text).not.toContain("visible-before-use@outside.test");
  expect(stage2Text).toContain(OMITTED_AFTER_USE);
  expect(stage2Msg.details?.contextBeforeUseText).toBe(stage1Text);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(stage2Msg);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("visible-before-use@outside.test");
  expect(ctx.state.outsideText).not.toContain("omitted-before-use@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-plain-two-stage@example.test");
});

it("preserves first-delivery watch snapshots across model policy switches", () => {
  const details = {
    routines: [
      {
        routineId: "r-model-switch",
        prompt: "Send weekly summary to owner-switch@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"x".repeat(12_000)} never-seen-switch@outside.test ${"y".repeat(12_000)}`,
          entries: {
            "item-seen": `${"s".repeat(165)} seen-before-switch@outside.test ${"t".repeat(165)}`,
            "item-extra": "e".repeat(900),
          },
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  const originalMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "switch-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "switch-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: raw }],
      details,
      isError: false,
      timestamp: 3,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "List schedules",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const policyA = createRuntimeContextPolicy(makeRequest("model-a", 7_200), undefined, {
    watchDeliveries,
  });
  const req1 = policyA.prepareContext(
    { systemPrompt: "Fixture", messages: originalMessages, tools: [] },
    makeModel("model-a", 7_200),
  );
  const req1Result = req1.messages.find((m) => m.role === "toolResult");
  const req1Text =
    req1Result && Array.isArray(req1Result.content) && req1Result.content[0]?.type === "text"
      ? req1Result.content[0].text
      : "";
  expect(req1Text.length).toBeGreaterThan(1_024);
  expect(req1Text).not.toContain("never-seen-switch@outside.test");
  expect(req1Text).toContain("seen-before-switch@outside.test");
  policyA.commitDelivery();

  // Switching models replaces the policy instance while keeping accepted watch provenance.
  // Staying in the same active user turn keeps switch-1 protected while making it after-use.
  const policyB = createRuntimeContextPolicy(makeRequest("model-b", 2_300), undefined, {
    watchDeliveries,
  });
  const req2 = policyB.prepareContext(
    {
      systemPrompt: "Fixture",
      messages: [
        ...originalMessages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "switch-2", name: "ask_user", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "model-a",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "switch-2",
          toolName: "ask_user",
          content: [{ type: "text", text: "y".repeat(7_500) }],
          isError: false,
          timestamp: 5,
        },
      ],
      tools: [],
    },
    makeModel("model-b", 2_300),
  );
  const req2Result = req2.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "switch-1",
  );
  const req2Text =
    req2Result && Array.isArray(req2Result.content) && req2Result.content[0]?.type === "text"
      ? req2Result.content[0].text
      : "";
  expect(req2Text).not.toContain("never-seen-switch@outside.test");
  expect(req2Text).not.toContain("seen-before-switch@outside.test");
  expect(req2Text).toContain(OMITTED_AFTER_USE);

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(req2Result);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).not.toContain("never-seen-switch@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-switch@example.test");
  expect(ctx.state.outsideText).toContain("seen-before-switch@outside.test");
});

it("preserves literal backslashes in a watch item title after structured and plain-text before-use cuts", () => {
  const item = `item:${JSON.stringify({
    fields: [JSON.stringify(`field-head ${"f".repeat(9_000)}`)],
    title: `${"t".repeat(9_000)} a\\nb@o.test`,
  })}`;
  const paddingEntries = Object.fromEntries(
    Array.from({ length: 94 }, (_, i) => [`pad-${String(i).padStart(3, "0")}`, "p".repeat(110)]),
  );
  const details = {
    routines: [
      {
        routineId: "r-title-backslash",
        prompt: "Send update to owner-title@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          entries: {
            ...paddingEntries,
            "item-1": item,
            "z-tail": "q".repeat(120),
          },
        },
      },
    ],
  };
  const structuredClipped = clipToolResultText(
    serializeToolResult(details, "cache-aware", "schedule_list", {}),
  );
  expect(() => JSON.parse(structuredClipped)).toThrow();
  expect(structuredClipped).not.toContain(',\\"title\\":');
  const plainBeforeUse = shortenToolResultText(
    structuredClipped,
    380,
    { name: "schedule_list" },
    { afterUse: false },
  );
  expect(() => JSON.parse(plainBeforeUse)).toThrow();
  expect(plainBeforeUse).not.toContain("omitted evidence is unavailable");
  expect(plainBeforeUse).toContain("a\\\\\\\\nb@o.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift({
    role: "toolResult",
    toolCallId: "title-backslash-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: plainBeforeUse }],
    details,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("a\\nb@o.test");
  expect(ctx.state.outsideText).not.toContain("a\nb@o.test");
  expect(ctx.state.outsideText).not.toContain("owner-title@example.test");
});

it("keeps ordinary after-use tool compaction local to each model policy across switches", () => {
  const reportText = `${"r".repeat(3_474)}REPORT_TOTAL=42`;
  expect(reportText.length).toBe(3_489);
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const messages: Message[] = [
    { role: "user", content: "Read report", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read_file", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read_file",
      content: [{ type: "text", text: reportText }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "step-2", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: "step-2",
      toolName: "ask_user",
      content: [{ type: "text", text: "y".repeat(6_000) }],
      isError: false,
      timestamp: 5,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "Read report",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const policyA = createRuntimeContextPolicy(makeRequest("model-a", 2_000), undefined, {
    watchDeliveries,
  });
  const reqA = policyA.prepareContext(
    { systemPrompt: "Fixture", messages, tools: [] },
    makeModel("model-a", 2_000),
  );
  const compactedRead = reqA.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "read-1",
  );
  const compactedText =
    compactedRead &&
    Array.isArray(compactedRead.content) &&
    compactedRead.content[0]?.type === "text"
      ? compactedRead.content[0].text
      : "";
  expect(compactedText.length).toBeLessThan(reportText.length);
  expect(compactedText).toContain(OMITTED_AFTER_USE);
  policyA.commitDelivery();

  const policyB = createRuntimeContextPolicy(makeRequest("model-b", 16_000), undefined, {
    watchDeliveries,
  });
  const reqB = policyB.prepareContext(
    { systemPrompt: "Fixture", messages, tools: [] },
    makeModel("model-b", 16_000),
  );
  const backupRead = reqB.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "read-1",
  );
  const backupText =
    backupRead && Array.isArray(backupRead.content) && backupRead.content[0]?.type === "text"
      ? backupRead.content[0].text
      : "";
  expect(backupText).toBe(reportText);
  expect(backupText).toContain("REPORT_TOTAL=42");
});

it("does not let a rejected primary request set first-delivery watch provenance for the backup", () => {
  const details = {
    routines: [
      {
        routineId: "r-rejected-primary",
        prompt: "Send update to owner-rejected@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(3_500)} backup-first-seen@outside.test ${"b".repeat(3_500)}`,
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const baseMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "rej-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "rej-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: raw }],
      details,
      isError: false,
      timestamp: 3,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "List schedules",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const primary = createRuntimeContextPolicy(makeRequest("model-a", 1_500), undefined, {
    watchDeliveries,
  });
  const rejectedReq = primary.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-a", 1_500),
  );
  const rejectedResult = rejectedReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const rejectedText =
    rejectedResult &&
    Array.isArray(rejectedResult.content) &&
    rejectedResult.content[0]?.type === "text"
      ? rejectedResult.content[0].text
      : "";
  expect(rejectedText.length).toBeLessThan(raw.length);
  expect(rejectedText).not.toContain("backup-first-seen@outside.test");
  // Primary failed before provider completion, so commitDelivery() is never called.

  const backup = createRuntimeContextPolicy(makeRequest("model-b", 16_000), undefined, {
    watchDeliveries,
  });
  const backupReq = backup.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-b", 16_000),
  );
  const backupResult = backupReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const backupText =
    backupResult && Array.isArray(backupResult.content) && backupResult.content[0]?.type === "text"
      ? backupResult.content[0].text
      : "";
  expect(backupText).toBe(raw);
  expect(backupText).toContain("backup-first-seen@outside.test");
  backup.commitDelivery();

  // Later after-use compaction on a narrower policy must remember backup's full accepted delivery.
  const narrow = createRuntimeContextPolicy(makeRequest("model-c", 2_000), undefined, {
    watchDeliveries,
  });
  const laterReq = narrow.prepareContext(
    {
      systemPrompt: "Fixture",
      messages: [
        ...baseMessages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "rej-2", name: "ask_user", arguments: {} }],
          api: "openai-responses",
          provider: "openai",
          model: "model-b",
          usage: emptyUsage,
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: "rej-2",
          toolName: "ask_user",
          content: [{ type: "text", text: "z".repeat(6_000) }],
          isError: false,
          timestamp: 5,
        },
      ],
      tools: [],
    },
    makeModel("model-c", 2_000),
  );
  const laterResult = laterReq.messages.find(
    (m) => m.role === "toolResult" && m.toolCallId === "rej-1",
  );
  const laterText =
    laterResult && Array.isArray(laterResult.content) && laterResult.content[0]?.type === "text"
      ? laterResult.content[0].text
      : "";
  expect(laterText).toContain(OMITTED_AFTER_USE);
  expect(laterText).not.toContain("backup-first-seen@outside.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(laterResult);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("backup-first-seen@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-rejected@example.test");
});

it("unions visible watch targets from a wider after-use delivery without restoring omitted spans", () => {
  const details = {
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(300)} seen-by-b@outside.test ${"m".repeat(8_000)} never-seen@outside.test ${"z".repeat(300)}`,
          entries: {
            "item-a": "seen-by-a@outside.test",
          },
        },
      },
    ],
  };
  const beforeUseText = JSON.stringify({
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(80)} [... omitted before use ...] ${"z".repeat(80)}`,
          entries: {
            "item-a": "seen-by-a@outside.test",
          },
        },
      },
    ],
  });
  const afterUseText = JSON.stringify({
    routines: [
      {
        routineId: "r-union",
        prompt: "Send update to owner-union@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(300)} seen-by-b@outside.test ${OMITTED_AFTER_USE} ${"z".repeat(300)}`,
          entries: {
            "item-a": `seen ${OMITTED_AFTER_USE}`,
          },
        },
      },
    ],
  });

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift({
    role: "toolResult",
    toolCallId: "union-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: afterUseText }],
    details: { ...details, contextBeforeUseText: beforeUseText },
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("seen-by-a@outside.test");
  expect(ctx.state.outsideText).toContain("seen-by-b@outside.test");
  expect(ctx.state.outsideText).not.toContain("never-seen@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-union@example.test");
});

it("preserves a fully accepted watch delivery when a narrower backup cuts it again", () => {
  const details = {
    routines: [
      {
        routineId: "r-full-then-narrow",
        prompt: "Send update to owner-full-narrow@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(3_500)} seen-by-backup-1@outside.test ${"b".repeat(3_500)}`,
        },
      },
    ],
  };
  const raw = JSON.stringify(details);
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const baseMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "fn-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "fn-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: raw }],
      details,
      isError: false,
      timestamp: 3,
    },
  ];
  const makeRequest = (modelId: string, contextWindow: number): AgentRunRequest =>
    ({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "List schedules",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "cache-aware",
      model: { provider: "openai", id: modelId, contextWindow, maxTokens: 0 },
    }) as unknown as AgentRunRequest;
  const makeModel = (id: string, contextWindow: number): Model<Api> =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      contextWindow,
      maxTokens: 0,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      name: id,
      baseUrl: "https://api.example.test",
    }) as unknown as Model<Api>;

  const watchDeliveries = new Map<string, WatchDeliveryState>();
  // Primary (narrow) cuts before use and completes.
  const primary = createRuntimeContextPolicy(makeRequest("model-a", 1_500), undefined, {
    watchDeliveries,
  });
  primary.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-a", 1_500),
  );
  primary.commitDelivery();

  // First backup (large) completes with the full watch result.
  const backup1 = createRuntimeContextPolicy(makeRequest("model-b", 16_000), undefined, {
    watchDeliveries,
  });
  const backup1Req = backup1.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-b", 16_000),
  );
  const backup1Result = backup1Req.messages.find((m) => m.role === "toolResult");
  expect(
    backup1Result &&
      Array.isArray(backup1Result.content) &&
      backup1Result.content[0]?.type === "text"
      ? backup1Result.content[0].text
      : "",
  ).toContain("seen-by-backup-1@outside.test");
  backup1.commitDelivery();

  // Second backup (narrow) cuts the result before use again before pausing on ask_user.
  const backup2 = createRuntimeContextPolicy(makeRequest("model-c", 1_500), undefined, {
    watchDeliveries,
  });
  const backup2Req = backup2.prepareContext(
    { systemPrompt: "Fixture", messages: baseMessages, tools: [] },
    makeModel("model-c", 1_500),
  );
  const backup2Result = backup2Req.messages.find((m) => m.role === "toolResult");
  const backup2Text =
    backup2Result &&
    Array.isArray(backup2Result.content) &&
    backup2Result.content[0]?.type === "text"
      ? backup2Result.content[0].text
      : "";
  expect(backup2Text).not.toContain("seen-by-backup-1@outside.test");

  const blob = JSON.parse(checkpoint("ask_user"));
  blob.messages.unshift(backup2Result);
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(restoreTurnCheckpointEffects(ctx, JSON.stringify(blob), model)).toBeDefined();
  expect(ctx.state.outsideText).toContain("seen-by-backup-1@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-full-narrow@example.test");
});
