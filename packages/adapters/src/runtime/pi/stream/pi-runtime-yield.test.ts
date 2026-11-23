import type { AssistantMessage, Context, Model, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { isConversationalRun } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointAnswerHistory } from "../../../runs/assembly/checkpoint-answer-history.js";
import { readThreadHistory } from "../../../runs/assembly/run-assembly-history.js";
import { claimRunSteering } from "../../../runs/turn/run-turn-images.js";
import { builtinAgentTools } from "../../../tools/builtin.tool-definition.js";

const fake = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => ({
      provider,
      id,
      name: id,
      api: "openai-completions",
      baseUrl: "https://models.invalid/v1",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    streamSimple: (...args: unknown[]) => fake.stream(...args),
  }),
}));
vi.mock("../models/pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("../models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "../pi-runtime.js";
import { releaseToolCallBudget } from "../tools/pi-runtime-tools.js";

/**
 * Each model call answers with the next step: a call to list_files at `path`, a question for
 * "ask", or the reply.
 */
function script(steps: Array<string | undefined>) {
  fake.stream.mockImplementation((target: Model<"openai-completions">) => {
    if (steps.length === 0) throw new Error("Unexpected model call");
    const path = steps.shift();
    const call: Pick<ToolCall, "name" | "arguments"> =
      path === "ask"
        ? { name: "ask_user", arguments: { question: "Which?", options: ["a", "b"] } }
        : { name: "list_files", arguments: { path: path ?? "" } };
    const message: AssistantMessage = {
      role: "assistant",
      api: target.api,
      provider: target.provider,
      model: target.id,
      content: path
        ? [{ type: "toolCall", id: `call-${path}`, ...call }]
        : [{ type: "text", text: "Done." }],
      stopReason: path ? "toolUse" : "stop",
      timestamp: 1,
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    stream.end(message);
    return stream;
  });
}

function request(stopping: AbortController, stopAt?: string): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: `yield-run-${Math.random()}`,
    prompt: "Look through the folders",
    instructions: "",
    history: [],
    tools: builtinAgentTools.filter((tool) => ["list_files", "ask_user"].includes(tool.name)),
    model: { provider: "test", id: "main", apiKey: "fake-key" },
    yieldSignal: stopping.signal,
    executeTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      // The process starts stopping while this step's tool call is running.
      if (args.path === stopAt) stopping.abort();
      return { entries: [`${args.path}/file.txt`] };
    }),
  };
}

/** Runs the turn; its executor hands the run back when asked unless `handBack` is false. */
async function run(input: AgentRunRequest, handBack = true) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {})) {
    events.push(event);
    if (event.type === "yielded") event.answer(handBack);
  }
  return events;
}

const calledPaths = (input: AgentRunRequest) =>
  vi.mocked(input.executeTool!).mock.calls.map(([, args]) => args.path);

beforeEach(() => {
  fake.stream.mockReset();
});

describe("a turn whose process starts stopping", () => {
  it("hands back after the step in flight, and resumes with the next model call", async () => {
    const stopping = new AbortController();
    const input = request(stopping, "a");
    script(["a", "b", undefined]);

    const events = await run(input);
    const yielded = events.find((event) => event.type === "yielded");
    expect(yielded).toBeDefined();
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(fake.stream).toHaveBeenCalledTimes(1);
    expect(calledPaths(input)).toEqual(["a"]);

    // Another process resumes the run from the turn the first one saved.
    const resumed = {
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: yielded?.type === "yielded" ? yielded.checkpoint : undefined,
    };
    const resumedEvents = await run(resumed);

    // The finished step is not repeated: the next model call already has its result.
    expect(calledPaths(resumed)).toEqual(["b"]);
    expect(fake.stream).toHaveBeenCalledTimes(3);
    const nextCall = fake.stream.mock.calls[1]![1] as Context;
    expect(nextCall.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-a",
    });
    expect(resumedEvents.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("hands back after a step during which an earlier shell command finished", async () => {
    const stopping = new AbortController();
    const input = request(stopping);
    const shell = deferred<{ stdout: string; stderr: string; code: number }>();
    input.executeTool = vi.fn(async (_name, args, _id, _route, observer) => {
      if (args.path === "a") observer?.onShellStillRunning?.(shell.promise);
      if (args.path === "b") {
        shell.resolve({ stdout: "built", stderr: "", code: 0 });
        stopping.abort();
      }
      return { entries: [`${args.path}/file.txt`] };
    });
    script(["a", "b", undefined]);

    const events = await run(input);
    const yielded = events.find((event) => event.type === "yielded");
    expect(yielded).toBeDefined();
    expect(fake.stream).toHaveBeenCalledTimes(2);

    // The shell's output was read here, so it travels with the saved turn.
    await run({
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: yielded?.type === "yielded" ? yielded.checkpoint : undefined,
    });
    const nextCall = fake.stream.mock.calls[2]![1] as Context;
    expect(JSON.stringify(nextCall.messages.at(-1))).toContain("stdout:\\nbuilt");
  });

  it("does not repeat a mid-turn message the saved turn already holds", async () => {
    const stopping = new AbortController();
    const input = request(stopping, "b");
    const steering = {
      id: "steer-1",
      messageId: "message-1",
      text: "Also check c",
      origin: "user",
    };
    // Claimed rows stay tied to the run, so every later claim of a fresh attempt returns them.
    let claims = 0;
    input.claimSteering = vi.fn(async () => (++claims === 2 ? [steering as never] : []));
    script(["a", "b", undefined]);

    const events = await run(input);
    const yielded = events.find((event) => event.type === "yielded");
    expect(yielded).toBeDefined();

    await run({
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: yielded?.type === "yielded" ? yielded.checkpoint : undefined,
      claimSteering: vi.fn(async (seen: string[]) => (seen.length ? [] : [steering as never])),
    });
    const nextCall = fake.stream.mock.calls[2]![1] as Context;
    const mentions = nextCall.messages.filter((message) =>
      JSON.stringify(message.content).includes("Also check c"),
    );
    expect(mentions).toHaveLength(1);
  });

  it("counts the saved turn's tool calls toward the per-turn limit on another process", async () => {
    vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "3");
    try {
      const input = request(new AbortController(), "b");
      script(["a", "b", "c", "d", undefined]);
      const events = await run(input);
      const yielded = events.find((event) => event.type === "yielded");
      expect(yielded).toBeDefined();
      // Another process holds no in-memory budget for the run.
      releaseToolCallBudget(input.runId, false);

      const resumed = { ...request(new AbortController()), runId: input.runId };
      const resumedEvents = await run({
        ...resumed,
        turnCheckpoint: yielded?.type === "yielded" ? yielded.checkpoint : undefined,
      });

      expect(calledPaths(resumed)).toEqual(["c"]);
      expect(resumedEvents).toContainEqual({
        type: "progress",
        text: "Stopped: more than 3 tool calls in one turn.",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("goes on in this process when the hand-back fails", async () => {
    const input = request(new AbortController(), "a");
    script(["a", "b", undefined]);

    const events = await run(input, false);

    expect(events.filter((event) => event.type === "yielded")).toHaveLength(1);
    expect(calledPaths(input)).toEqual(["a", "b"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });

  it("finishes a turn whose last step is in flight instead of handing it back", async () => {
    const stopping = new AbortController();
    stopping.abort();
    const input = request(stopping);
    script([undefined]);

    const events = await run(input);

    expect(events.some((event) => event.type === "yielded")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
  });
});

it("counts a question the turn paused on toward the per-turn limit on another process", async () => {
  vi.stubEnv("MAX_TOOL_CALLS_PER_TURN", "2");
  try {
    const input = request(new AbortController());
    let checkpoint = "";
    input.onCheckpoint = async (capture) => {
      checkpoint = capture();
    };
    script(["a", "ask", "b", "c", undefined]);
    expect(await run(input)).toContainEqual(expect.objectContaining({ type: "ask" }));
    releaseToolCallBudget(input.runId, false);

    const resumed = { ...request(new AbortController()), runId: input.runId };
    const events = await run({
      ...resumed,
      turnCheckpoint: checkpoint,
      resumeToolResult: { content: [{ type: "text", text: "a" }] },
    });

    expect(calledPaths(resumed)).toEqual([]);
    expect(events).toContainEqual({
      type: "progress",
      text: "Stopped: more than 2 tool calls in one turn.",
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("runs every step of a turn whose process is not stopping", async () => {
  const input = request(new AbortController());
  script(["a", "b", undefined]);

  const events = await run(input);

  expect(events.some((event) => event.type === "yielded")).toBe(false);
  expect(calledPaths(input)).toEqual(["a", "b"]);
  expect(fake.stream).toHaveBeenCalledTimes(3);
  expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
});

it.each(["user", "routine", "follow_up", "helper"])(
  "deduplicates answer history across successive questions in a %s run",
  async (trigger) => {
    const input = request(new AbortController());
    let checkpoint = "";
    input.onCheckpoint = async (capture) => {
      checkpoint = capture();
    };
    script(["ask", "ask", undefined]);
    expect(await run(input)).toContainEqual(expect.objectContaining({ type: "ask" }));
    const answer = "Use the garden entrance";
    // Background tasks deliberately keep a cumulative task prompt. Preserve that contract.
    const firstResult = isConversationalRun(trigger)
      ? answer
      : `${input.prompt}\n\nWhich?\nAnswer: ${answer}`;
    const card = {
      id: "ask-card",
      threadId: "thread",
      runId: input.runId,
      role: "bot",
      botId: "bot",
      seq: 1,
      steeringMessages: [],
      blocks: [
        {
          kind: "ask",
          text: "Which?",
          actions: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
          status: "answered",
          answer,
          answerMessageId: "typed-answer",
        },
      ],
    };
    const reply = {
      id: "typed-answer",
      threadId: "thread",
      runId: input.runId,
      role: "user",
      seq: 2,
      steeringMessages: [],
      blocks: [{ kind: "text", text: answer }],
    };
    const parts = {
      turnCheckpoint: checkpoint,
      records: {
        bot: { id: "bot" },
        thread: { id: "thread", historyCompactionSummary: null, historyCompactedUpToSeq: null },
        messages: [reply, card],
        historyReach: "all",
        replaysToolHistory: true,
      },
    };
    const history = await readThreadHistory(
      {
        run: {
          id: input.runId,
          trigger,
          userId: "user",
          spaceId: "space",
          threadId: "thread",
          botId: "bot",
        },
        deps: { prisma: { message: { findMany: vi.fn(async () => [card]) } } },
      } as never,
      parts as never,
    );
    const projected = await checkpointAnswerHistory(
      { message: { findMany: vi.fn(async () => [card]) } } as never,
      { id: input.runId, threadId: "thread", botId: "bot" },
      history.compactedHistory.history,
      [reply, card],
      false,
    );
    await run({
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: checkpoint,
      onCheckpoint: async (capture) => {
        checkpoint = capture();
      },
      resumeToolResult: {
        content: [{ type: "text", text: firstResult }],
        historyMessageIds: projected.representedMessageIds,
      },
      history: projected.history,
    });
    expect(JSON.parse(checkpoint).historyMessageIds).toEqual(
      expect.arrayContaining(["ask-card", "typed-answer"]),
    );
    const nextCall = fake.stream.mock.calls[1]![1] as Context;
    const mentions = nextCall.messages.filter((message) =>
      JSON.stringify(message.content).includes(answer),
    );
    expect(mentions).toEqual([
      expect.objectContaining({
        role: "toolResult",
        toolName: "ask_user",
        content: [{ type: "text", text: firstResult }],
      }),
    ]);
    const secondAnswer = "Bring the blue folder";
    const secondResult = isConversationalRun(trigger)
      ? secondAnswer
      : `${firstResult}\n\nWhich?\nAnswer: ${secondAnswer}`;
    const secondCard = {
      ...card,
      id: "second-card",
      blocks: card.blocks.map((block) => ({
        ...block,
        answer: secondAnswer,
        answerMessageId: "second-answer",
      })),
    };
    const secondReply = {
      ...reply,
      id: "second-answer",
      blocks: [{ kind: "text", text: secondAnswer }],
    };
    const secondHistory = [
      ...history.compactedHistory.history,
      { id: secondCard.id, role: "assistant" as const, content: `Which? Answer: ${secondAnswer}` },
      { id: secondReply.id, role: "user" as const, content: secondAnswer },
    ];
    const secondProjection = await checkpointAnswerHistory(
      { message: { findMany: vi.fn(async () => [card, secondCard]) } } as never,
      { id: input.runId, threadId: "thread", botId: "bot" },
      secondHistory,
      [reply, card, secondReply, secondCard],
      false,
    );
    await run({
      ...request(new AbortController()),
      runId: input.runId,
      turnCheckpoint: checkpoint,
      resumeToolResult: {
        content: [{ type: "text", text: secondResult }],
        historyMessageIds: secondProjection.representedMessageIds,
      },
      history: secondProjection.history,
    });
    const lastCall = fake.stream.mock.calls[2]![1] as Context;
    const results = [firstResult, secondResult];
    for (const text of [answer, secondAnswer]) {
      expect(
        lastCall.messages.filter((message) => JSON.stringify(message.content).includes(text)),
      ).toEqual(
        results
          .filter((result) => result.includes(text))
          .map((result) =>
            expect.objectContaining({
              role: "toolResult",
              toolName: "ask_user",
              content: [{ type: "text", text: result }],
            }),
          ),
      );
    }
  },
);

it("keeps a resumed answer's steered image and file without repeating its text", async () => {
  const input = request(new AbortController());
  let checkpoint = "";
  input.onCheckpoint = async (capture) => {
    checkpoint = capture();
  };
  script(["ask", undefined]);
  await run(input);
  const answer = "Use this entrance plan";
  const card = {
    id: "card",
    blocks: [
      {
        kind: "ask",
        text: "Which?",
        status: "answered",
        answer,
        answerMessageId: "answer",
        actions: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
      },
    ],
  };
  const blocks: MessageBlock[] = [
    { kind: "text", text: answer },
    {
      kind: "image",
      artifactId: "image",
      name: "entrance.png",
      mimeType: "image/png",
      imageHandling: "confirm",
    },
    { kind: "file", artifactId: "file", name: "entrance.txt", mimeType: "text/plain", size: 3 },
  ];
  const projection = await checkpointAnswerHistory(
    { message: { findMany: vi.fn(async () => [card]) } } as never,
    { id: input.runId, threadId: "thread", botId: "bot" },
    [{ id: "card", role: "assistant", content: `Which? Answer: ${answer}` }],
    [{ id: "answer", threadId: "thread", role: "user", blocks }],
    false,
  );
  const data = new Uint8Array([1, 2, 3]);
  const deps = {
    events: {
      claimSteering: vi.fn(async ({ seenIds }: { seenIds: string[] }) =>
        seenIds.length
          ? []
          : [{ id: "steering", messageId: "answer", origin: "user", text: answer, blocks }],
      ),
    },
    prisma: {
      artifact: {
        findMany: vi.fn(async () => [
          {
            id: "image",
            storageKey: "image",
            name: "entrance.png",
            mimeType: "image/png",
            size: 3,
          },
          { id: "file", storageKey: "file", name: "entrance.txt", mimeType: "text/plain", size: 3 },
        ]),
      },
    },
    artifacts: { get: vi.fn(async () => data) },
  };
  const pendingFiles: MessageBlock[][] = [];
  await run({
    ...request(new AbortController()),
    runId: input.runId,
    turnCheckpoint: checkpoint,
    history: projection.history,
    resumeToolResult: {
      content: [{ type: "text", text: answer }],
      historyMessageIds: projection.representedMessageIds,
    },
    claimSteering: (seenIds) =>
      claimRunSteering(
        deps as never,
        {
          runId: input.runId,
          threadId: "thread",
          botId: "bot",
          leaseOwner: "worker",
          leaseFence: 1,
        },
        seenIds,
        {
          operationId: input.runId,
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          runId: input.runId,
          signal: new AbortController().signal,
        },
        pendingFiles,
        { hasImages: false, resumeAnswerReplyContexts: projection.answerReplyContexts },
      ),
  });
  const nextCall = fake.stream.mock.calls[1]![1] as Context;
  expect(
    nextCall.messages.filter((message) => JSON.stringify(message.content).includes(answer)),
  ).toEqual([expect.objectContaining({ role: "toolResult", toolName: "ask_user" })]);
  expect(nextCall.messages).toContainEqual(
    expect.objectContaining({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("entrance.txt") }),
        { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/png" },
      ]),
    }),
  );
  expect(pendingFiles).toEqual([blocks]);
});
