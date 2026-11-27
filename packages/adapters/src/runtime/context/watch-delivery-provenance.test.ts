import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
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
import { serializeTurnCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  buildTurnCheckpoint,
  serializeCapturedTurnCheckpoint,
} from "../pi/pi-runtime-checkpoint.js";
import { shortenToolResultText } from "./context-selection.js";
import type { WatchDeliveryState } from "./runtime-context.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import {
  applyWatchDeliveryProvenance,
  commitWatchDeliveries,
} from "./watch-delivery-provenance.js";

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

it("keeps a newer accepted slice of an earlier watch after a watch delivered in between", () => {
  const slice = (toolCallId: string, marker: string): WatchDeliveryState => {
    const details = {
      routines: [
        {
          routineId: toolCallId,
          prompt: "Owner prompt",
          lastCheck: {
            checkedAt: "2026-11-25T07:00:00.000Z",
            detail: `Alert ${marker}`,
          },
        },
      ],
    };
    return {
      full: false,
      texts: [JSON.stringify(details)],
      details,
      toolCallId,
    };
  };
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: slice("call-a", "alpha-old-target@outside.test") },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-b", state: slice("call-b", "beta-target@outside.test") },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: slice("call-a", "alpha-new-target@outside.test") },
  ]);
  const checkpoint = buildTurnCheckpoint({
    stateMessages: [],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-order",
    toolCallCount: 1,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const markers = [
    "alpha-old-target@outside.test",
    "beta-target@outside.test",
    "alpha-new-target@outside.test",
  ];
  const positions = markers.map((marker) =>
    (checkpoint.watchOutsideText ?? []).findIndex((entry) => entry.includes(marker)),
  );
  expect(positions[0]).toBeGreaterThanOrEqual(0);
  expect(positions[1]).toBeGreaterThan(positions[0]!);
  expect(positions[2]).toBeGreaterThan(positions[1]!);
});

it("bounds persisted watchOutsideText to the newest tail across repeated dropped reads", () => {
  const marker = (index: number) => `${String(index).padStart(2, "0")}-watch-target@outside.test`;
  const chunk = (index: number) => `${marker(index)}${"q".repeat(120_000)}`;
  let carried: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const checkpoint = buildTurnCheckpoint({
      stateMessages: [],
      restoringCalls: false,
      tools: [],
      pendingToolCallId: "pause-bound",
      toolCallCount: index + 1,
      mainModelConfig: { provider: "openai", id: "model-a" },
      provider: "openai",
      modelId: "model-a",
      systemPrompt: "Fixture",
      representedHistoryIds: new Set(),
      priorWatchOutsideText: [...carried, chunk(index)],
    });
    carried = checkpoint.watchOutsideText ?? [];
    expect(carried.join("\n").length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  }
  const joined = carried.join("\n");
  expect(joined.length).toBe(MAX_OUTSIDE_TEXT_CHARS);
  expect(joined).not.toContain(marker(0));
  expect(joined).not.toContain(marker(1));
  const kept = [2, 3, 4].map((index) => joined.indexOf(marker(index)));
  expect(kept[0]).toBeGreaterThanOrEqual(0);
  expect(kept[1]).toBeGreaterThan(kept[0]!);
  expect(kept[2]).toBeGreaterThan(kept[1]!);
  const first = carried[0]!;
  const sources = [0, 1, 2, 3, 4].map(chunk);
  expect(sources.some((entry) => entry.endsWith(first) && entry.length > first.length)).toBe(true);
});

it("keeps a newer dropped watch slice when restore replays a large retained watch accepted between the slices", () => {
  const dropped = (toolCallId: string, marker: string): WatchDeliveryState => {
    const details = {
      routines: [
        {
          routineId: toolCallId,
          prompt: "Owner prompt",
          lastCheck: {
            checkedAt: "2026-11-25T07:00:00.000Z",
            detail: `Alert ${marker}`,
          },
        },
      ],
    };
    return {
      full: false,
      texts: [JSON.stringify(details)],
      details,
      toolCallId,
    };
  };
  const retainedDetails = {
    routines: [
      {
        routineId: "call-b",
        prompt: "Owner prompt",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: "b".repeat(MAX_OUTSIDE_TEXT_CHARS),
        },
      },
    ],
  };
  const retainedMessage: Message = {
    role: "toolResult",
    toolCallId: "call-b",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(retainedDetails) }],
    details: retainedDetails,
    isError: false,
    timestamp: 1,
  };
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: dropped("call-a", "alpha-old-target@outside.test") },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    {
      key: "watch-b",
      state: {
        full: true,
        fullText: JSON.stringify(retainedDetails),
        details: retainedDetails,
        toolCallId: "call-b",
      },
    },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: dropped("call-a", "alpha-new-kept@outside.test") },
  ]);
  const checkpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: [retainedMessage], tools: [] },
      sourceLength: 1,
    },
    stateMessages: [retainedMessage],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-restore-order",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(checkpoint), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  expect(ctx.state.outsideText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(ctx.state.outsideText).toContain("alpha-new-kept@outside.test");
});

it("keeps an earlier full watch ahead of a later watch when a shortened resend re-queues it", () => {
  const watchMessage = (toolCallId: string, marker: string): Message => {
    const details = {
      routines: [
        {
          routineId: toolCallId,
          prompt: "Owner prompt",
          lastCheck: {
            checkedAt: "2026-11-25T07:00:00.000Z",
            detail: `Alert ${marker}`,
          },
        },
      ],
    };
    return {
      role: "toolResult",
      toolCallId,
      toolName: "schedule_list",
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: false,
      timestamp: 1,
    };
  };
  const hash = (message: Message) => (message.role === "toolResult" ? message.toolCallId : "x");
  const watchA = watchMessage("call-a", "alpha-old-target@outside.test");
  const watchB = watchMessage("call-b", "beta-target@outside.test");
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const accept = (source: Message, delivered: Message = source) => {
    const applied = applyWatchDeliveryProvenance(
      { messages: [source] } as Context,
      [delivered],
      [0],
      watchDeliveries,
      hash,
    );
    commitWatchDeliveries(watchDeliveries, applied.pending);
  };
  accept(watchA);
  accept(watchB);
  accept(watchA, { ...watchA, content: [{ type: "text", text: "short" }] });
  const checkpoint = buildTurnCheckpoint({
    stateMessages: [],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-resend",
    toolCallCount: 1,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const markers = ["alpha-old-target@outside.test", "beta-target@outside.test"];
  const positions = markers.map((marker) =>
    (checkpoint.watchOutsideText ?? []).findIndex((entry) => entry.includes(marker)),
  );
  expect(positions[0]).toBeGreaterThanOrEqual(0);
  expect(positions[1]).toBeGreaterThan(positions[0]!);
});

it("does not start capped watchOutsideText on a lone UTF-16 surrogate", () => {
  const emoji = "😀";
  const loneLowSurrogate = (value: string) => {
    const code = value.charCodeAt(0);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const singleMarker = "single-surrogate-tail@outside.test";
  const single = buildTurnCheckpoint({
    stateMessages: [],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-surrogate",
    toolCallCount: 1,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    priorWatchOutsideText: [
      `${emoji}${"x".repeat(MAX_OUTSIDE_TEXT_CHARS - 1 - singleMarker.length)}${singleMarker}`,
    ],
  });
  const singleText = single.watchOutsideText?.join("\n") ?? "";
  expect(singleText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(loneLowSurrogate(singleText)).toBe(false);
  expect(singleText).toContain(singleMarker);

  const multiMarker = "multi-surrogate-tail@outside.test";
  const newestMarker = "newest-surrogate-tail@outside.test";
  const newest = `${"n".repeat(100)}${newestMarker}`;
  const room = MAX_OUTSIDE_TEXT_CHARS - newest.length - 1;
  const older = `${emoji}${"y".repeat(room + 1 - 2 - multiMarker.length)}${multiMarker}`;
  const multi = buildTurnCheckpoint({
    stateMessages: [],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-surrogate",
    toolCallCount: 1,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    priorWatchOutsideText: [older, newest],
  });
  const multiEntries = multi.watchOutsideText ?? [];
  const multiText = multiEntries.join("\n");
  expect(multiText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(multiEntries.some(loneLowSurrogate)).toBe(false);
  expect(multiText.indexOf(newestMarker)).toBeGreaterThan(multiText.indexOf(multiMarker));
});

const turnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function assistantCall(id: string, name: string, timestamp: number): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp,
  };
}
function watchPayload(routineId: string, marker: string, padding = "") {
  return {
    routines: [
      {
        routineId,
        prompt: "Owner prompt",
        lastCheck: {
          checkedAt: "2026-11-25T07:00:00.000Z",
          detail: padding ? `${padding} ${marker}` : `Alert ${marker}`,
        },
      },
    ],
  };
}
function markerPositions(text: string, markers: readonly string[]): number[] {
  return markers.map((marker) => text.indexOf(marker));
}

it("keeps a newer dropped watch slice on the second pause when a large retained watch sits between the slices", () => {
  const dropped = (toolCallId: string, marker: string): WatchDeliveryState => {
    const details = watchPayload(toolCallId, marker);
    return {
      full: false,
      texts: [JSON.stringify(details)],
      details,
      toolCallId,
    };
  };
  const retainedDetails = watchPayload(
    "call-b",
    "beta-retained@outside.test",
    "b".repeat(MAX_OUTSIDE_TEXT_CHARS),
  );
  const retainedMessage: Message = {
    role: "toolResult",
    toolCallId: "call-b",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(retainedDetails) }],
    details: retainedDetails,
    isError: false,
    timestamp: 2,
  };
  const pending = assistantCall("pause-second", "ask_user", 3);
  const transcript: Message[] = [
    assistantCall("call-b", "schedule_list", 1),
    retainedMessage,
    pending,
  ];
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: dropped("call-a", "alpha-old-target@outside.test") },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    {
      key: "watch-b",
      state: {
        full: true,
        fullText: JSON.stringify(retainedDetails),
        details: retainedDetails,
        toolCallId: "call-b",
      },
    },
  ]);
  commitWatchDeliveries(watchDeliveries, [
    { key: "watch-a", state: dropped("call-a", "alpha-second-pause@outside.test") },
  ]);
  const first = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: transcript, tools: [] },
      sourceLength: transcript.length,
    },
    stateMessages: transcript,
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-second",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const firstCtx = fixture([tool("ask_user")]);
  firstCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(firstCtx, JSON.stringify(first), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  expect(firstCtx.state.outsideText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(firstCtx.state.outsideText).toContain("alpha-second-pause@outside.test");

  // A resumed run starts a fresh delivery map and only carries the saved watch text forward.
  const second = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: first.messages, tools: [] },
      sourceLength: first.messages.length,
    },
    stateMessages: [...first.messages, assistantCall("pause-third", "ask_user", 4)],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-third",
    toolCallCount: 3,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: new Map(),
    priorWatchOutsideText: first.watchOutsideText,
    restoredMessages: first.messages,
  });
  expect(second).not.toHaveProperty("watchOutsideTextBefore");
  expect((second.watchOutsideText ?? []).join("\n").length).toBeLessThanOrEqual(
    MAX_OUTSIDE_TEXT_CHARS,
  );
  expect(second.watchOutsideText?.join("\n")).toContain("alpha-second-pause@outside.test");
  const secondCtx = fixture([tool("ask_user")]);
  secondCtx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(secondCtx, JSON.stringify(second), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  expect(secondCtx.state.outsideText.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(secondCtx.state.outsideText).toContain("alpha-second-pause@outside.test");
});

it("replays multiple accepted slices of one retained watch in acceptance order", () => {
  const sliceJson = (routineId: string, marker: string) =>
    JSON.stringify(watchPayload(routineId, marker));
  const firstA = sliceJson("call-a", "slice-a@outside.test");
  const firstB = sliceJson("call-b", "slice-b@outside.test");
  const secondA = sliceJson("call-a", "slice-a-prime@outside.test");
  const secondB = sliceJson("call-b", "slice-b-prime@outside.test");
  const retainedDetails = {
    ...watchPayload("call-b", "slice-b@outside.test"),
    contextBeforeUseText: firstB,
    contextDeliveredTexts: [firstB, secondB],
  };
  const retainedMessage: Message = {
    role: "toolResult",
    toolCallId: "call-b",
    toolName: "schedule_list",
    content: [{ type: "text", text: firstB }],
    details: retainedDetails,
    isError: false,
    timestamp: 2,
  };
  const detailsA = watchPayload("call-a", "slice-a@outside.test");
  const watchDeliveries = new Map<string, WatchDeliveryState>([
    [
      "watch-a",
      {
        full: false,
        texts: [firstA, secondA],
        textOrders: [1, 3],
        details: detailsA,
        toolCallId: "call-a",
      },
    ],
    [
      "watch-b",
      {
        full: false,
        texts: [firstB, secondB],
        textOrders: [2, 4],
        details: retainedDetails,
        toolCallId: "call-b",
      },
    ],
  ]);
  const transcript: Message[] = [
    assistantCall("call-b", "schedule_list", 1),
    retainedMessage,
    assistantCall("pause-slices", "ask_user", 3),
  ];
  const checkpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: transcript, tools: [] },
      sourceLength: transcript.length,
    },
    stateMessages: transcript,
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-slices",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(checkpoint), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  const markers = [
    "slice-a@outside.test",
    "slice-b@outside.test",
    "slice-a-prime@outside.test",
    "slice-b-prime@outside.test",
  ];
  const positions = markerPositions(ctx.state.outsideText, markers);
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions[1]).toBeGreaterThan(positions[0]!);
  expect(positions[2]).toBeGreaterThan(positions[1]!);
  expect(positions[3]).toBeGreaterThan(positions[2]!);
  expect(ctx.state.outsideText).not.toContain("Owner prompt");
});

it("keeps watch evidence when a saved index is past the transcript or a trailing aborted message is trimmed", () => {
  const pending = {
    role: "assistant",
    content: [{ type: "toolCall", id: "pending", name: "ask_user", arguments: {} }],
    stopReason: "toolUse",
    timestamp: 1,
  };
  const aborted = { ...pending, content: [], stopReason: "aborted", timestamp: 2 };
  const model = { provider: "openai", id: "model-a" };
  const restoreSaved = (
    messages: unknown[],
    watchOutsideText: string[],
    watchOutsideTextBefore: number[],
  ) => {
    const ctx = fixture([tool("ask_user")]);
    ctx.state.outsideText = "";
    expect(
      restoreTurnCheckpointEffects(
        ctx,
        JSON.stringify({
          version: 1,
          provider: model.provider,
          model: model.id,
          systemPrompt: "Fixture",
          pendingToolCallId: "pending",
          executionMode: "sequential",
          messages,
          watchOutsideText,
          watchOutsideTextBefore,
        }),
        model,
      ),
    ).toBeDefined();
    return ctx.state.outsideText;
  };
  const trimmed = restoreSaved(
    [pending, aborted],
    ["trim-kept@outside.test", "trim-dropped@outside.test", "trim-after-dropped@outside.test"],
    [0, 2, 3],
  );
  const outOfRange = restoreSaved(
    [pending],
    ["range-kept@outside.test", "range-dropped@outside.test", "range-after-dropped@outside.test"],
    [0, 8, 9],
  );
  expect([
    trimmed.includes("trim-kept@outside.test"),
    trimmed.includes("trim-dropped@outside.test"),
    trimmed.includes("trim-after-dropped@outside.test"),
    outOfRange.includes("range-kept@outside.test"),
    outOfRange.includes("range-dropped@outside.test"),
    outOfRange.includes("range-after-dropped@outside.test"),
  ]).toEqual([true, true, true, true, true, true]);
});

it("keeps an undelivered watch after an earlier page read and leaves the page out of watch text", () => {
  const droppedDetails = watchPayload("call-a", "delivered-watch@outside.test");
  const unseenDetails = watchPayload("call-unseen", "unseen-watch@outside.test");
  const unseenMessage: Message = {
    role: "toolResult",
    toolCallId: "call-unseen",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(unseenDetails) }],
    details: unseenDetails,
    isError: false,
    timestamp: 2,
  };
  const page: Message = {
    role: "toolResult",
    toolCallId: "page-1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "Fetched page web-fetch-kept@outside.test" }],
    isError: false,
    timestamp: 1,
  };
  const transcript: Message[] = [page, unseenMessage, assistantCall("pause-unseen", "ask_user", 3)];
  const watchDeliveries = new Map<string, WatchDeliveryState>([
    [
      "watch-a",
      {
        full: true,
        fullText: JSON.stringify(droppedDetails),
        details: droppedDetails,
        toolCallId: "call-a",
        order: 1,
      },
    ],
  ]);
  const checkpoint = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: transcript, tools: [] },
      sourceLength: transcript.length,
    },
    stateMessages: transcript,
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-unseen",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries,
  });
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(checkpoint), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  const positions = markerPositions(ctx.state.outsideText, [
    "delivered-watch@outside.test",
    "unseen-watch@outside.test",
    "web-fetch-kept@outside.test",
  ]);
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions[2]).toBeGreaterThan(positions[0]!);
  expect(positions[1]).toBeGreaterThan(positions[2]!);
  expect(checkpoint).not.toHaveProperty("watchOutsideTextBefore");
  expect(checkpoint.watchOutsideText?.join("\n")).not.toContain("web-fetch-kept@outside.test");
});

function pauseCheckpoint(messages: Message[], pendingToolCallId: string) {
  return buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages, tools: [] },
      sourceLength: messages.length,
    },
    stateMessages: messages,
    restoringCalls: false,
    tools: [],
    pendingToolCallId,
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
  });
}

function restoredOutside(checkpoint: ReturnType<typeof buildTurnCheckpoint>): string {
  const ctx = fixture([tool("ask_user")]);
  ctx.state.outsideText = "";
  expect(
    restoreTurnCheckpointEffects(ctx, JSON.stringify(checkpoint), {
      provider: "openai",
      id: "model-a",
    }),
  ).toBeDefined();
  return ctx.state.outsideText;
}

function pageRead(id: string, text: string, timestamp: number): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "web_fetch",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function routineRead(id: string, marker: string, padding = ""): Message {
  const details = watchPayload(id, marker, padding);
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: false,
    timestamp: 2,
  };
}

/** Real resume path: `prepareContext` queues a delivery for every restored routine result. */
function deliveredWatches(messages: Message[]): Map<string, WatchDeliveryState> {
  const watchDeliveries = new Map<string, WatchDeliveryState>();
  const policy = createRuntimeContextPolicy(
    {
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "Fixture",
      instructions: "Fixture",
      history: [],
      tools: [],
      secrets: [],
      contextStrategy: "current",
      model: { provider: "openai", id: "model-a", contextWindow: 1_000_000, maxTokens: 0 },
    } as unknown as AgentRunRequest,
    undefined,
    { watchDeliveries },
  );
  policy.prepareContext({ systemPrompt: "Fixture", messages, tools: [] }, {
    id: "model-a",
    provider: "openai",
    api: "openai-responses",
    contextWindow: 1_000_000,
    maxTokens: 0,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    name: "model-a",
    baseUrl: "https://api.example.test",
  } as unknown as Model<Api>);
  policy.commitDelivery();
  return watchDeliveries;
}

function resumedCheckpoint(
  prior: ReturnType<typeof buildTurnCheckpoint>,
  stateMessages: Message[],
  pendingToolCallId: string,
): ReturnType<typeof buildTurnCheckpoint> {
  return buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: stateMessages, tools: [] },
      sourceLength: stateMessages.length,
    },
    stateMessages,
    restoringCalls: false,
    tools: [],
    pendingToolCallId,
    toolCallCount: (prior.toolCallCount ?? 0) + 1,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: deliveredWatches(stateMessages),
    priorOutsideText: prior.outsideText,
    priorWatchOutsideText: prior.watchOutsideText,
    restoredMessages: prior.messages,
  });
}

it("keeps the newer of a page read and a watch check when the older one fills the cap", () => {
  const olderPage = pageRead(
    "page-old",
    `${"p".repeat(MAX_OUTSIDE_TEXT_CHARS)} older-page@outside.test`,
    1,
  );
  const newerWatch = routineRead("call-watch", "newer-watch@outside.test");
  const watchAfterPage = pauseCheckpoint(
    [olderPage, newerWatch, assistantCall("pause-watch-after-page", "ask_user", 3)],
    "pause-watch-after-page",
  );
  const watchTail = restoredOutside(watchAfterPage);
  expect(watchTail.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(watchTail).toContain("newer-watch@outside.test");
  expect(watchAfterPage.watchOutsideText?.join("\n") ?? "").not.toContain(
    "older-page@outside.test",
  );

  const olderWatch = routineRead(
    "call-old-watch",
    "older-watch@outside.test",
    "w".repeat(MAX_OUTSIDE_TEXT_CHARS),
  );
  const newerPage = pageRead("page-new", "Fetched newer-page@outside.test", 2);
  const pageAfterWatch = pauseCheckpoint(
    [olderWatch, newerPage, assistantCall("pause-page-after-watch", "ask_user", 3)],
    "pause-page-after-watch",
  );
  expect((pageAfterWatch.watchOutsideText ?? []).join("\n").length).toBeGreaterThan(
    MAX_OUTSIDE_TEXT_CHARS / 2,
  );
  const pageTail = restoredOutside(pageAfterWatch);
  expect(pageTail.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(pageTail).toContain("newer-page@outside.test");
  expect(pageAfterWatch.watchOutsideText?.join("\n") ?? "").not.toContain(
    "newer-page@outside.test",
  );
});

it("keeps A, B, A' when a second pause drops the retained watch", () => {
  const kept = routineRead("call-b", "order-b@outside.test");
  const restored = [
    assistantCall("call-b", "schedule_list", 1),
    kept,
    assistantCall("pause-order", "ask_user", 3),
  ];
  const first = pauseCheckpoint(restored, "pause-order");
  const keptText = first.watchOutsideText?.[0];
  expect(keptText).toContain("order-b@outside.test");
  const prior = [
    keptText!.replaceAll("order-b@outside.test", "order-a@outside.test"),
    keptText!,
    keptText!.replaceAll("order-b@outside.test", "order-a-prime@outside.test"),
  ];
  const dropped = buildTurnCheckpoint({
    sentContext: {
      context: {
        systemPrompt: "Fixture",
        messages: [restored[0]!, restored[2]!],
        tools: [],
      },
      sourceLength: 2,
    },
    stateMessages: [restored[0]!, restored[2]!],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-order",
    toolCallCount: 3,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: new Map(),
    priorWatchOutsideText: prior,
    restoredMessages: restored,
  });
  expect(dropped).not.toHaveProperty("watchOutsideTextBefore");
  expect(dropped.watchOutsideText).toEqual(prior);
});

it("does not copy a clipped web_fetch sibling into checkpoint watch text", () => {
  const assistant: Message = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "pause-parallel", name: "ask_user", arguments: {} },
      { type: "toolCall", id: "page-sib", name: "web_fetch", arguments: {} },
      { type: "toolCall", id: "watch-sib", name: "schedule_list", arguments: {} },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp: 1,
  };
  const checkpoint = pauseCheckpoint([assistant], "pause-parallel");
  const pageSibling: Message = {
    role: "toolResult",
    toolCallId: "page-sib",
    toolName: "web_fetch",
    content: [{ type: "text", text: "clipped fetch fetched-sibling@outside.test" }],
    isError: false,
    timestamp: 2,
  };
  const watchDetails = watchPayload("watch-sib", "sibling-watch@outside.test");
  const watchSibling: Message = {
    role: "toolResult",
    toolCallId: "watch-sib",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(watchDetails) }],
    details: watchDetails,
    isError: false,
    timestamp: 3,
  };
  const saved = JSON.parse(
    serializeCapturedTurnCheckpoint(
      checkpoint,
      "pause-parallel",
      new Map([
        ["page-sib", pageSibling],
        ["watch-sib", watchSibling],
      ]),
    ),
  ) as { watchOutsideText?: string[] };
  const watchText = saved.watchOutsideText?.join("\n") ?? "";
  expect(watchText).not.toContain("fetched-sibling@outside.test");
  expect(watchText).toContain("sibling-watch@outside.test");
});

it("does not save meeting transcript speech in checkpoint outside text", () => {
  const speech = "secret-meeting-speech@outside.test";
  const transcript: Message = {
    role: "toolResult",
    toolCallId: "meeting-read",
    toolName: "read_meeting_transcript",
    content: [{ type: "text", text: `Recorded ${speech}` }],
    details: { transcript: speech },
    isError: false,
    timestamp: 2,
  };
  const checkpoint = pauseCheckpoint(
    [
      routineRead("call-watch", "kept-watch@outside.test"),
      transcript,
      pageRead("page-kept", "Fetched kept-page@outside.test", 3),
      assistantCall("pause-meeting", "ask_user", 4),
    ],
    "pause-meeting",
  );
  const serialized = serializeTurnCheckpoint(checkpoint);
  const saved = JSON.parse(serialized) as { outsideText?: string; messages: Message[] };
  expect(serialized).not.toContain(speech);
  expect(saved.outsideText).toContain("kept-page@outside.test");
  expect(saved.outsideText).toContain("kept-watch@outside.test");
  expect(JSON.stringify(saved.messages)).toContain("Read it again");
  expect(JSON.stringify(saved.messages)).not.toContain(speech);
});

it("keeps the newer identical watch when a full page sits between the two reads", () => {
  const marker = "repeated-watch@outside.test";
  const checkpoint = pauseCheckpoint(
    [
      routineRead("watch-first", marker),
      pageRead(
        "page-between",
        `${"p".repeat(MAX_OUTSIDE_TEXT_CHARS)} page-between@outside.test`,
        2,
      ),
      routineRead("watch-second", marker),
      assistantCall("pause-repeated-watch", "ask_user", 4),
    ],
    "pause-repeated-watch",
  );
  const tail = restoredOutside(checkpoint);
  expect(tail.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(tail).toContain(marker);
});

it("keeps a repeated watch on the second pause when intervening pages fill the cap", () => {
  const marker = "repeated-pause@outside.test";
  const firstMessages = [
    pageRead("page-small", "Fetched small-page@outside.test", 1),
    routineRead("watch-first", marker),
    assistantCall("pause-first", "ask_user", 3),
  ];
  const first = pauseCheckpoint(firstMessages, "pause-first");
  expect(first.outsideText).toContain(marker);
  const secondMessages = [
    ...firstMessages,
    pageRead("page-huge", "p".repeat(MAX_OUTSIDE_TEXT_CHARS), 4),
    routineRead("watch-second", marker),
    assistantCall("pause-second", "ask_user", 5),
  ];
  const deliveries = deliveredWatches(secondMessages);
  const freshIndex = [...deliveries.values()].find(
    (entry) => entry.toolCallId === "watch-second",
  )?.sourceIndex;
  expect(freshIndex).toBeGreaterThanOrEqual(first.messages.length);
  const second = resumedCheckpoint(first, secondMessages, "pause-second");
  const tail = restoredOutside(second);
  expect(tail.length).toBeLessThanOrEqual(MAX_OUTSIDE_TEXT_CHARS);
  expect(tail).toContain(marker);
});

it("builds outside text when a page sibling finishes a watch-only checkpoint", () => {
  const watch = routineRead("call-watch-only", "watch-only@outside.test");
  const assistant: Message = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "pause-watch-only", name: "ask_user", arguments: {} },
      { type: "toolCall", id: "page-after-watch", name: "web_fetch", arguments: {} },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp: 3,
  };
  const checkpoint = pauseCheckpoint(
    [assistantCall("call-watch-only", "schedule_list", 1), watch, assistant],
    "pause-watch-only",
  );
  expect(checkpoint.outsideText).toBeUndefined();
  expect(checkpoint.watchOutsideText?.join("\n") ?? "").toContain("watch-only@outside.test");
  const pageSibling: Message = {
    role: "toolResult",
    toolCallId: "page-after-watch",
    toolName: "web_fetch",
    content: [{ type: "text", text: "Fetched page-after-watch@outside.test" }],
    isError: false,
    timestamp: 4,
  };
  const saved = JSON.parse(
    serializeCapturedTurnCheckpoint(
      checkpoint,
      "pause-watch-only",
      new Map([["page-after-watch", pageSibling]]),
    ),
  ) as { outsideText?: string; watchOutsideText?: string[] };
  expect(saved.outsideText).toContain("watch-only@outside.test");
  expect(saved.outsideText).toContain("page-after-watch@outside.test");
  expect(saved.outsideText!.indexOf("page-after-watch@outside.test")).toBeGreaterThan(
    saved.outsideText!.indexOf("watch-only@outside.test"),
  );
  expect(saved.watchOutsideText?.join("\n") ?? "").not.toContain("page-after-watch@outside.test");
  expect(saved.watchOutsideText?.join("\n") ?? "").toContain("watch-only@outside.test");
});

it("does not replay a restored watch into outside text on later pauses", () => {
  const marker = "old-watch@outside.test";
  const state = [
    assistantCall("watch-old", "schedule_list", 1),
    routineRead("watch-old", marker),
    pageRead("page-fill", `${"p".repeat(MAX_OUTSIDE_TEXT_CHARS)} newer-page@outside.test`, 2),
    assistantCall("pause-filled", "ask_user", 3),
  ];
  const first = pauseCheckpoint(state, "pause-filled");
  expect(first.outsideText).toContain("newer-page@outside.test");
  expect(first.outsideText).not.toContain(marker);
  const replayed = deliveredWatches(state);
  const restoredIndex = [...replayed.values()].find(
    (entry) => entry.toolCallId === "watch-old",
  )?.sourceIndex;
  expect(restoredIndex).toBeTypeOf("number");
  expect(restoredIndex).toBeLessThan(state.length);
  const second = resumedCheckpoint(first, state, "pause-filled");
  const third = resumedCheckpoint(second, state, "pause-filled");
  expect(second.outsideText).toBe(first.outsideText);
  expect(third.outsideText).toBe(first.outsideText);
  expect(second.outsideText).not.toContain(marker);
  expect(third.outsideText).not.toContain(marker);
});

it("keeps retained pages when a routine sibling finishes a page-only checkpoint", () => {
  const assistant: Message = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "pause-page-only", name: "ask_user", arguments: {} },
      { type: "toolCall", id: "watch-after-page", name: "schedule_list", arguments: {} },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp: 3,
  };
  const checkpoint = pauseCheckpoint(
    [
      pageRead("page-kept", `${"p".repeat(MAX_OUTSIDE_TEXT_CHARS)} kept-page@outside.test`, 1),
      assistant,
    ],
    "pause-page-only",
  );
  expect(checkpoint.outsideText).toBeUndefined();
  const watchDetails = watchPayload("watch-after-page", "watch-after-page@outside.test");
  const watchSibling: Message = {
    role: "toolResult",
    toolCallId: "watch-after-page",
    toolName: "schedule_list",
    content: [{ type: "text", text: JSON.stringify(watchDetails) }],
    details: watchDetails,
    isError: false,
    timestamp: 4,
  };
  const saved = JSON.parse(
    serializeCapturedTurnCheckpoint(
      checkpoint,
      "pause-page-only",
      new Map([["watch-after-page", watchSibling]]),
    ),
  ) as { outsideText?: string; watchOutsideText?: string[] };
  expect(saved.outsideText).toContain("kept-page@outside.test");
  expect(saved.outsideText).toContain("watch-after-page@outside.test");
  expect(saved.outsideText!.indexOf("watch-after-page@outside.test")).toBeGreaterThan(
    saved.outsideText!.indexOf("kept-page@outside.test"),
  );
  expect(saved.watchOutsideText?.join("\n") ?? "").not.toContain("kept-page@outside.test");
});

it("does not save routines-shaped results from other tools as watch evidence", () => {
  const payload = "external routine payload";
  const foreignDetails = () => ({
    routines: [{ name: "ext", lastCheck: { detail: payload } }],
  });
  const foreignResult = (id: string, toolName: string, timestamp: number): Message => {
    const details = foreignDetails();
    return {
      role: "toolResult",
      toolCallId: id,
      toolName,
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: false,
      timestamp,
    };
  };
  const useTool = (id: string, name: string, timestamp: number): Message => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "use_tool", arguments: { name } }],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp,
  });
  const catalogRead = (id: string, marker: string, timestamp: number): Message => {
    const details = watchPayload(id, marker);
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: "task_catalog",
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: false,
      timestamp,
    };
  };
  const wrappedWatch = (id: string, marker: string, timestamp: number): Message => {
    const details = watchPayload(id, marker);
    return {
      role: "toolResult",
      toolCallId: id,
      toolName: "use_tool",
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: false,
      timestamp,
    };
  };
  const reused = "call-reused-wrap";
  const messages: Message[] = [
    assistantCall("call-direct-schedule", "schedule_list", 1),
    routineRead("call-direct-schedule", "direct-schedule@outside.test"),
    assistantCall("call-direct-catalog", "task_catalog", 3),
    catalogRead("call-direct-catalog", "direct-catalog@outside.test", 4),
    useTool("call-wrapped-schedule", "schedule_list", 5),
    wrappedWatch("call-wrapped-schedule", "wrapped-schedule@outside.test", 6),
    useTool("call-wrapped-catalog", "task_catalog", 7),
    wrappedWatch("call-wrapped-catalog", "wrapped-catalog@outside.test", 8),
    useTool(reused, "schedule_list", 9),
    wrappedWatch(reused, "reused-schedule@outside.test", 10),
    useTool(reused, "task_catalog", 11),
    wrappedWatch(reused, "reused-catalog@outside.test", 12),
    useTool(reused, "web_fetch", 13),
    foreignResult(reused, "use_tool", 14),
    assistantCall("call-foreign-page", "web_fetch", 15),
    foreignResult("call-foreign-page", "web_fetch", 16),
    useTool("call-foreign-wrapped", "mcp_external", 17),
    foreignResult("call-foreign-wrapped", "use_tool", 18),
    assistantCall("pause-foreign", "ask_user", 19),
  ];
  const deliveries = deliveredWatches(messages);
  const deliveredIds = [...deliveries.values()].map((entry) => entry.toolCallId);
  expect(deliveredIds.filter((id) => id === "call-direct-schedule")).toHaveLength(1);
  expect(deliveredIds.filter((id) => id === "call-direct-catalog")).toHaveLength(1);
  expect(deliveredIds.filter((id) => id === "call-wrapped-schedule")).toHaveLength(1);
  expect(deliveredIds.filter((id) => id === "call-wrapped-catalog")).toHaveLength(1);
  expect(deliveredIds.filter((id) => id === reused)).toHaveLength(2);
  expect(deliveredIds).not.toContain("call-foreign-page");
  expect(deliveredIds).not.toContain("call-foreign-wrapped");
  expect(deliveries.size).toBe(6);

  const checkpoint = pauseCheckpoint(messages, "pause-foreign");
  const watchText = checkpoint.watchOutsideText?.join("\n") ?? "";
  for (const marker of [
    "direct-schedule@outside.test",
    "direct-catalog@outside.test",
    "wrapped-schedule@outside.test",
    "wrapped-catalog@outside.test",
    "reused-schedule@outside.test",
    "reused-catalog@outside.test",
  ]) {
    expect(watchText).toContain(marker);
  }
  expect(watchText).not.toContain(payload);
  const outside = checkpoint.outsideText ?? "";
  expect(outside.split(payload).length - 1).toBe(3);
  expect(outside).toContain("direct-schedule@outside.test");

  // A dropped foreign result must not be re-extracted into a later checkpoint's watch list.
  const droppedForeignCall = useTool("call-legacy-foreign", "web_fetch", 30);
  const droppedForeign = foreignResult("call-legacy-foreign", "use_tool", 31);
  const fresh = routineRead("call-fresh", "fresh-schedule@outside.test");
  const legacyMessages = [fresh, assistantCall("pause-legacy", "ask_user", 33)];
  const legacy = buildTurnCheckpoint({
    sentContext: {
      context: { systemPrompt: "Fixture", messages: legacyMessages, tools: [] },
      sourceLength: legacyMessages.length,
    },
    stateMessages: legacyMessages,
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-legacy",
    toolCallCount: 2,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    restoredMessages: [
      droppedForeignCall,
      droppedForeign,
      assistantCall("pause-old", "ask_user", 32),
    ],
    watchDeliveries: new Map(),
  });
  const legacyWatch = legacy.watchOutsideText?.join("\n") ?? "";
  expect(legacyWatch).toContain("fresh-schedule@outside.test");
  expect(legacyWatch).not.toContain(payload);
});

it("resolves a deferred routine from the source transcript when the assistant call was compacted away", () => {
  const payload = "external routine payload";
  const reused = "call-reused-source";
  const schedule = watchPayload(reused, "source-schedule@outside.test");
  const foreign = { routines: [{ name: "ext", lastCheck: { detail: payload } }] };
  const call = (name: string, timestamp: number): Message => ({
    role: "assistant",
    content: [{ type: "toolCall", id: reused, name: "use_tool", arguments: { name } }],
    api: "openai-responses",
    provider: "openai",
    model: "model-a",
    usage: turnUsage,
    stopReason: "toolUse",
    timestamp,
  });
  const result = (
    details: ReturnType<typeof watchPayload> | typeof foreign,
    timestamp: number,
  ): Message => ({
    role: "toolResult",
    toolCallId: reused,
    toolName: "use_tool",
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    isError: false,
    timestamp,
  });
  const scheduleResult = result(schedule, 2);
  const foreignResult = result(foreign, 4);
  const state: Message[] = [
    call("schedule_list", 1),
    scheduleResult,
    call("web_fetch", 3),
    foreignResult,
  ];
  const applied = applyWatchDeliveryProvenance(
    { messages: state } as Context,
    [scheduleResult, foreignResult],
    [1, 3],
    undefined,
    (message) => JSON.stringify(message.content),
  );
  expect(applied.pending).toHaveLength(1);
  expect(JSON.stringify(applied.pending[0]?.state.details)).toContain(
    "source-schedule@outside.test",
  );
  expect(JSON.stringify(applied.pending[0]?.state.details)).not.toContain(payload);

  const pause = assistantCall("pause-source", "ask_user", 5);
  const checkpoint = buildTurnCheckpoint({
    sentContext: {
      context: {
        systemPrompt: "Fixture",
        messages: [scheduleResult, foreignResult],
        tools: [],
      },
      sourceLength: state.length,
      sourceIndexes: [1, 3],
    },
    stateMessages: [...state, pause],
    restoringCalls: false,
    tools: [],
    pendingToolCallId: "pause-source",
    toolCallCount: 3,
    mainModelConfig: { provider: "openai", id: "model-a" },
    provider: "openai",
    modelId: "model-a",
    systemPrompt: "Fixture",
    representedHistoryIds: new Set(),
    watchDeliveries: new Map(),
    restoredMessages: [scheduleResult, foreignResult, pause],
  });
  const watchText = checkpoint.watchOutsideText?.join("\n") ?? "";
  expect(watchText).toContain("source-schedule@outside.test");
  expect(watchText).not.toContain(payload);
  expect((checkpoint.outsideText ?? "").split(payload).length - 1).toBe(1);
  expect(checkpoint.outsideText).toContain("source-schedule@outside.test");
});
