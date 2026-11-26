import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import {
  MAX_OUTSIDE_TEXT_CHARS,
  outsideOnlyTargets,
} from "../../approvals/review-target-sources.js";
import { estimateModelContextTokens } from "../../models/model-context.js";
import type { RunContext } from "../../runs/assembly/run-context.js";
import { restoreTurnCheckpointEffects } from "../../runs/assembly/run-context.js";
import { watchChecksFromToolResultMessage } from "../../runs/assembly/watch-outside-text.js";
import { buildTurnCheckpoint } from "../pi/pi-runtime-checkpoint.js";
import { shortenToolResultText } from "./context-selection.js";
import type { WatchDeliveryState } from "./runtime-context.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";

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

it("retains accepted watch provenance in checkpoints when context selection drops the watch result and ignores provenance in token estimates", () => {
  const details = {
    routines: [
      {
        routineId: "r-dropped-watch",
        prompt: "Send update to owner-dropped@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"d".repeat(4_000)} dropped-watch-target@outside.test ${"e".repeat(4_000)}`,
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
  const watchResultMsg: Message = {
    role: "toolResult",
    toolCallId: "drop-1",
    toolName: "schedule_list",
    content: [{ type: "text", text: raw }],
    details,
    isError: false,
    timestamp: 3,
  };
  const fullStateMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "drop-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    watchResultMsg,
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
  const primary = createRuntimeContextPolicy(makeRequest("model-a", 16_000), undefined, {
    watchDeliveries,
  });
  primary.prepareContext(
    { systemPrompt: "Fixture", messages: fullStateMessages, tools: [] },
    makeModel("model-a", 16_000),
  );
  primary.commitDelivery();

  // Token estimates must ignore internal watch provenance metadata on details.
  const withoutProvenance = {
    systemPrompt: "Fixture",
    messages: [watchResultMsg],
    tools: [],
  };
  const withProvenance = {
    systemPrompt: "Fixture",
    messages: [
      {
        ...watchResultMsg,
        details: {
          ...details,
          contextBeforeUseText: raw,
          contextDeliveredTexts: [raw, "x".repeat(4_000)],
        },
      },
    ],
    tools: [],
  };
  expect(estimateModelContextTokens(withProvenance)).toBe(
    estimateModelContextTokens(withoutProvenance),
  );

  // Backup drops the watch toolResult from sentContext and pauses on ask_user.
  const askAssistant: Message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "ask-drop", name: "ask_user", arguments: {} }],
    api: "openai-responses",
    provider: "openai",
    model: "model-b",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 6,
  };
  const droppedContextMessages: Message[] = [
    { role: "user", content: "Continue", timestamp: 4 },
    {
      role: "toolResult",
      toolCallId: "read-after",
      toolName: "read_file",
      content: [{ type: "text", text: "r".repeat(6_000) }],
      isError: false,
      timestamp: 5,
    },
  ];
  const savedCheckpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: droppedContextMessages, tools: [] },
      sourceLength: 5,
    },
    stateMessages: [...fullStateMessages, ...droppedContextMessages, askAssistant],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "ask-drop",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-b" },
    provider: "openai",
    modelId: "model-b",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  expect(
    savedCheckpoint.messages.some((m) => m.role === "toolResult" && m.toolCallId === "drop-1"),
  ).toBe(false);
  expect(savedCheckpoint.watchOutsideText?.join("\n")).toContain(
    "dropped-watch-target@outside.test",
  );
  expect(savedCheckpoint.watchOutsideText?.join("\n")).not.toContain("owner-dropped@example.test");

  const ctx = fixture([tool("ask_user")]);
  ctx.state.tainted = false;
  ctx.state.taintedBeyondOwnComputer = false;
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(savedCheckpoint), {
      provider: "openai",
      id: "model-b",
    }),
  ).toBeDefined();
  expect(ctx.state.tainted).toBe(true);
  expect(ctx.state.taintedBeyondOwnComputer).toBe(true);
  expect(ctx.state.outsideText).toContain("dropped-watch-target@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-dropped@example.test");

  // A subsequent checkpoint after resume carries priorWatchOutsideText forward.
  const secondCheckpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: droppedContextMessages, tools: [] },
      sourceLength: 2,
    },
    stateMessages: [...droppedContextMessages, askAssistant],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "ask-drop",
    toolCallCount: 3,
    mainModelConfig: { provider: "openai", id: "model-b" },
    provider: "openai",
    modelId: "model-b",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: new Map(),
    priorWatchOutsideText: savedCheckpoint.watchOutsideText,
  });
  expect(secondCheckpoint.watchOutsideText).toEqual(savedCheckpoint.watchOutsideText);
});

it("preserves restored watch targets on a second checkpoint after a resumed attempt compacts and then drops the watch result", () => {
  const details = {
    routines: [
      {
        routineId: "r-second-checkpoint",
        prompt: "Send update to owner-second@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(3_500)} first-attempt-target@outside.test ${"b".repeat(3_500)}`,
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
  const firstWatchResult: Message = {
    role: "toolResult",
    toolCallId: "watch-r1",
    toolName: "schedule_list",
    content: [{ type: "text", text: raw }],
    details,
    isError: false,
    timestamp: 3,
  };
  const firstCheckpointMessages: Message[] = [
    { role: "user", content: "List schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "watch-r1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    firstWatchResult,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 4,
    },
  ];
  // Resumed attempt compacts watch-r1 (dropping the target from its compacted delivery) and records
  // that narrower delivery in watchDeliveries before a narrow backup drops watch-r1 entirely.
  const compactedText = shortenToolResultText(
    raw,
    1_024,
    { name: "schedule_list" },
    { afterUse: true },
  );
  expect(compactedText).not.toContain("first-attempt-target@outside.test");
  const resumedDeliveries = new Map<string, WatchDeliveryState>([
    [
      "hash-watch-r1",
      {
        full: false,
        texts: [compactedText],
        details,
        toolCallId: "watch-r1",
      },
    ],
  ]);
  const secondAskAssistant: Message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "ask-2", name: "ask_user", arguments: {} }],
    api: "openai-responses",
    provider: "openai",
    model: "model-b",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 8,
  };
  const keptOnBackup: Message[] = [
    { role: "user", content: "Continue", timestamp: 6 },
    {
      role: "toolResult",
      toolCallId: "read-2",
      toolName: "read_file",
      content: [{ type: "text", text: "r".repeat(6_000) }],
      isError: false,
      timestamp: 7,
    },
  ];
  const secondCheckpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: keptOnBackup, tools: [] },
      sourceLength: 7,
    },
    stateMessages: [...firstCheckpointMessages, ...keptOnBackup, secondAskAssistant],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "ask-2",
    toolCallCount: 3,
    mainModelConfig: { provider: "openai", id: "model-b" },
    provider: "openai",
    modelId: "model-b",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: resumedDeliveries,
    restoredMessages: firstCheckpointMessages,
  });

  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(secondCheckpoint), {
      provider: "openai",
      id: "model-b",
    }),
  ).toBeDefined();
  expect(ctx.state.outsideText).toContain("first-attempt-target@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-second@example.test");
  expect(
    outsideOnlyTargets(
      { to: ["first-attempt-target@outside.test"] },
      { ownerWords: ["List schedules"], outsideText: ctx.state.outsideText },
    ),
  ).toEqual(["first-attempt-target@outside.test"]);
});

it("preserves delivery order so older restored watch evidence never evicts a newer target", () => {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  // Each older watch result expands to ~220k chars (two together exceed MAX_OUTSIDE_TEXT_CHARS).
  const olderDetails1 = {
    routines: [
      {
        routineId: "r-old-1",
        prompt: "Owner prompt 1",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: "é".repeat(220_000),
        },
      },
    ],
  };
  const olderDetails2 = {
    routines: [
      {
        routineId: "r-old-2",
        prompt: "Owner prompt 2",
        lastCheck: {
          checkedAt: "2026-11-25T07:01:00.000Z",
          detail: "ñ".repeat(220_000),
        },
      },
    ],
  };
  const newerDetails = {
    routines: [
      {
        routineId: "r-new",
        prompt: "Owner prompt new",
        lastCheck: {
          checkedAt: "2026-11-25T07:05:00.000Z",
          detail: "Alert newer-watch-target@outside.test",
        },
      },
    ],
  };
  const firstCheckpointMessages: Message[] = [
    { role: "user", content: "Check schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "old-1", name: "schedule_list", arguments: {} },
        { type: "toolCall", id: "old-2", name: "schedule_list", arguments: {} },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "old-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: JSON.stringify(olderDetails1) }],
      details: olderDetails1,
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "old-2",
      toolName: "schedule_list",
      content: [{ type: "text", text: JSON.stringify(olderDetails2) }],
      details: olderDetails2,
      isError: false,
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 5,
    },
  ];
  const newerRaw = JSON.stringify(newerDetails);
  const resumedDeliveries = new Map<string, WatchDeliveryState>([
    [
      "hash-new",
      {
        full: true,
        fullText: newerRaw,
        details: newerDetails,
        toolCallId: "new-1",
      },
    ],
  ]);
  const keptOnBackup: Message[] = [
    { role: "user", content: "Continue", timestamp: 6 },
    {
      role: "toolResult",
      toolCallId: "read-after",
      toolName: "read_file",
      content: [{ type: "text", text: "r".repeat(6_000) }],
      isError: false,
      timestamp: 7,
    },
  ];
  const secondAsk: Message = {
    role: "assistant",
    content: [{ type: "toolCall", id: "ask-2", name: "ask_user", arguments: {} }],
    api: "openai-responses",
    provider: "openai",
    model: "model-b",
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 8,
  };
  const secondCheckpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: keptOnBackup, tools: [] },
      sourceLength: 7,
    },
    stateMessages: [...firstCheckpointMessages, ...keptOnBackup, secondAsk],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "ask-2",
    toolCallCount: 4,
    mainModelConfig: { provider: "openai", id: "model-b" },
    provider: "openai",
    modelId: "model-b",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: resumedDeliveries,
    restoredMessages: firstCheckpointMessages,
  });

  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(secondCheckpoint), {
      provider: "openai",
      id: "model-b",
    }),
  ).toBeDefined();
  expect(ctx.state.outsideText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(ctx.state.outsideText).toContain("newer-watch-target@outside.test");
  expect(
    outsideOnlyTargets(
      { to: ["newer-watch-target@outside.test"] },
      { ownerWords: ["Check schedules"], outsideText: ctx.state.outsideText },
    ),
  ).toEqual(["newer-watch-target@outside.test"]);
});

it("matches watch delivery provenance by call occurrence when a provider reuses a tool-call ID across turns", () => {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const firstDetails = {
    routines: [
      {
        routineId: "r-reused-1",
        prompt: "Send routine one update to owner-reused-1@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: `${"a".repeat(2_000)} first-reused-target@outside.test ${"b".repeat(2_000)}`,
        },
      },
    ],
  };
  const secondDetails = {
    routines: [
      {
        routineId: "r-reused-2",
        prompt: "Send routine two update to owner-reused-2@example.test",
        lastCheck: {
          checkedAt: "2026-11-25T07:05:00.000Z",
          detail: `${"c".repeat(2_000)} second-reused-target@outside.test ${"d".repeat(2_000)}`,
        },
      },
    ],
  };
  const firstRaw = JSON.stringify(firstDetails);
  const secondRaw = JSON.stringify(secondDetails);
  const reusedCallId = "call-reused";
  const makeModel = (id: string, contextWindow: number) => ({
    id,
    name: id,
    api: "openai-responses" as const,
    provider: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 1_024,
  });
  const request = {
    runId: "run-reused-call-id",
    botId: "bot-1",
    threadId: "thread-1",
    prompt: "Review both watch schedules",
    instructions: "Fixture",
    history: [],
    tools: [],
    model: { provider: "openai", id: "model-wide", contextWindow: 32_000 },
    contextStrategy: "snapshots" as const,
  };
  const stateMessages: Message[] = [
    { role: "user", content: request.prompt, timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: reusedCallId, name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-wide",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: reusedCallId,
      toolName: "schedule_list",
      content: [{ type: "text", text: firstRaw }],
      details: firstDetails,
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: reusedCallId, name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-wide",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 4,
    },
    {
      role: "toolResult",
      toolCallId: reusedCallId,
      toolName: "schedule_list",
      content: [{ type: "text", text: secondRaw }],
      details: secondDetails,
      isError: false,
      timestamp: 5,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read_file", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-wide",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 6,
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read_file",
      content: [{ type: "text", text: "r".repeat(6_000) }],
      isError: false,
      timestamp: 7,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-2", name: "read_file", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-wide",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 8,
    },
    {
      role: "toolResult",
      toolCallId: "read-2",
      toolName: "read_file",
      content: [{ type: "text", text: "s".repeat(6_000) }],
      isError: false,
      timestamp: 9,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-3", name: "read_file", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-wide",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 10,
    },
    {
      role: "toolResult",
      toolCallId: "read-3",
      toolName: "read_file",
      content: [{ type: "text", text: "t".repeat(6_000) }],
      isError: false,
      timestamp: 11,
    },
  ];
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const widePolicy = createRuntimeContextPolicy(request, undefined, { watchDeliveries });
  widePolicy.prepareContext(
    { systemPrompt: "Fixture", messages: stateMessages, tools: [] },
    makeModel("model-wide", 32_000),
  );
  widePolicy.commitDelivery();
  expect(watchDeliveries.size).toBe(2);

  // Switch to a narrower backup whose rebuild compacts the first watch result after use while
  // keeping the second watch result, even though both share the same toolCallId.
  const narrowPolicy = createRuntimeContextPolicy(
    { ...request, model: { provider: "openai", id: "model-narrow", contextWindow: 10_000 } },
    undefined,
    { watchDeliveries },
  );
  const narrowPrepared = narrowPolicy.prepareContext(
    { systemPrompt: "Fixture", messages: stateMessages, tools: [] },
    makeModel("model-narrow", 10_000),
  );
  const watchResults = narrowPrepared.messages.filter(
    (message): message is Extract<Message, { role: "toolResult" }> =>
      message.role === "toolResult" && message.toolCallId === reusedCallId,
  );
  expect(watchResults).toHaveLength(2);
  const firstText = watchResults[0]!.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(firstText.length).toBeLessThan(firstRaw.length);
  const firstExtracted = JSON.stringify(
    watchChecksFromToolResultMessage(watchResults[0]!, request.contextStrategy),
  );
  expect(firstExtracted).toContain("first-reused-target@outside.test");
  expect(firstExtracted).not.toContain("second-reused-target@outside.test");
  expect(firstExtracted).not.toContain("owner-reused-1@example.test");

  const checkpoint = buildTurnCheckpoint({
    sentContext: {
      context: narrowPrepared,
      sourceLength: stateMessages.length,
      sourceIndexes: narrowPolicy.getLastSourceIndexes(),
    },
    stateMessages: [
      ...stateMessages,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "ask-reused", name: "ask_user", arguments: {} }],
        api: "openai-responses",
        provider: "openai",
        model: "model-narrow",
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 12,
      },
    ],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "ask-reused",
    toolCallCount: 6,
    mainModelConfig: { provider: "openai", id: "model-narrow" },
    provider: "openai",
    modelId: "model-narrow",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
    contextStrategy: request.contextStrategy,
  });

  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(checkpoint), {
      provider: "openai",
      id: "model-narrow",
    }),
  ).toBeDefined();
  expect(ctx.state.outsideText).toContain("first-reused-target@outside.test");
  expect(ctx.state.outsideText).toContain("second-reused-target@outside.test");
  expect(ctx.state.outsideText).not.toContain("owner-reused-1@example.test");
  expect(ctx.state.outsideText).not.toContain("owner-reused-2@example.test");
});

it("does not duplicate retained watch results into watchOutsideText when Pi prepends a leading system message on resume", () => {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const details = {
    routines: [
      {
        routineId: "r-legacy-sys",
        prompt: "Owner prompt",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: "Alert legacy-watch-target@outside.test",
        },
      },
    ],
  };
  // Legacy v1 checkpoint without a leading system message.
  const legacyRestoredMessages: Message[] = [
    { role: "user", content: "Check schedules", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "watch-1", name: "schedule_list", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "watch-1",
      toolName: "schedule_list",
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: false,
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "ask-1", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 4,
    },
  ];
  const systemMessage = {
    role: "system",
    content: "Fixture system prompt",
    timestamp: 0,
  } as unknown as Message;
  const initializedStateMessages: Message[] = [
    systemMessage,
    ...legacyRestoredMessages,
    {
      role: "toolResult",
      toolCallId: "ask-1",
      toolName: "ask_user",
      content: [{ type: "text", text: "Continue" }],
      isError: false,
      timestamp: 5,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "ask-2", name: "ask_user", arguments: {} }],
      api: "openai-responses",
      provider: "openai",
      model: "model-a",
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 6,
    },
  ];
  // Both passing Pi's initialized restored transcript and passing raw legacy restored messages
  // must recognize that watch-1 at state index 3 is still retained in messages.
  for (const restoredMessages of [
    initializedStateMessages.slice(0, legacyRestoredMessages.length + 1),
    legacyRestoredMessages,
  ]) {
    const checkpoint = buildTurnCheckpoint({
      sentContext: {
        context: {
          systemPrompt: "Fixture system prompt",
          messages: initializedStateMessages.slice(0, 6),
          tools: [],
        },
        sourceLength: 6,
        sourceIndexes: [0, 1, 2, 3, 4, 5],
      },
      stateMessages: initializedStateMessages,
      restoringCalls: false,
      tools: [],
      pendingToolCallId: "ask-2",
      toolCallCount: 2,
      mainModelConfig: { provider: "openai", id: "model-a" },
      provider: "openai",
      modelId: "model-a",
      systemPrompt: "Fixture system prompt",
      representedHistoryIds: new Set(),
      restoredMessages,
    });
    expect(checkpoint.watchOutsideText).toBeUndefined();
    expect(
      checkpoint.messages.some((m) => m.role === "toolResult" && m.toolCallId === "watch-1"),
    ).toBe(true);
  }
});
