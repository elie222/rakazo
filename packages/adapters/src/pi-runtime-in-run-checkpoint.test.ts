import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const model: Model<"openai-completions"> = {
  provider: "fixture",
  id: "replay-model",
  name: "replay-model",
  api: "openai-completions",
  baseUrl: "https://models.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 20_000,
  maxTokens: 2_000,
};

function assistant(content: AssistantMessage["content"], input = 1_000): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function response(message: AssistantMessage) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type === "text") {
      stream.push({ type: "text_delta", contentIndex, delta: part.text, partial: message });
    } else if (part.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
  }
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  stream.end(message);
  return stream;
}

const previousFraction = process.env.IN_RUN_CHECKPOINT_CONTEXT_FRACTION;

beforeEach(() => {
  process.env.IN_RUN_CHECKPOINT_CONTEXT_FRACTION = "0.5";
  providerState.models.clear();
  providerState.models.set(`${model.provider}/${model.id}`, model as never);
  providerState.stream.mockReset();
});

afterEach(() => {
  if (previousFraction === undefined) delete process.env.IN_RUN_CHECKPOINT_CONTEXT_FRACTION;
  else process.env.IN_RUN_CHECKPOINT_CONTEXT_FRACTION = previousFraction;
});

describe("long tool-loop replay", () => {
  it("compacts and continues the same run before replaying the full recorded call shape", async () => {
    const plannedCalls = 209;
    let step = 0;
    const contexts: Context[] = [];
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      contexts.push(structuredClone(context));
      const wire = JSON.stringify(context.messages);
      if (wire.includes("Create a compact progress checkpoint")) {
        return response(
          assistant(
            [
              {
                type: "text",
                text: "Goal: finish the synthetic browser survey. Completed effects: steps 0-31. Next: re-observe the current page and continue at step 32.",
              },
            ],
            12_000,
          ),
        );
      }
      if (wire.includes("<progress_checkpoint>"))
        return response(assistant([{ type: "text", text: "Survey complete." }], 1_000));
      const current = step++;
      if (current >= plannedCalls) return response(assistant([{ type: "text", text: "Done." }]));
      return response(
        assistant(
          [
            {
              type: "toolCall",
              id: `call-${current}`,
              name: "computer_act",
              arguments: { step: current },
            },
          ],
          1_000 + current * 500,
        ),
      );
    });

    const request: AgentRunRequest = {
      botId: "bot",
      threadId: "thread",
      runId: "run",
      prompt: "Survey listings in the browser",
      instructions: "Use the computer and keep verified notes.",
      history: [],
      tools: [
        {
          name: "computer_act",
          description: "Perform one browser action",
          inputSchema: {
            type: "object",
            properties: { step: { type: "number" } },
            required: ["step"],
          },
          readOnly: false,
        },
      ],
      model: { provider: model.provider, id: model.id, apiKey: "fixture-key" },
      executeTool: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
        ok: true,
        step: Number(args.step),
        page: `Synthetic page evidence ${"detail ".repeat(1_200)}`,
      })),
    } as unknown as AgentRunRequest;

    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(request, {
      operationId: "operation",
      traceId: "trace",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(step).toBeGreaterThan(1);
    expect(step).toBeLessThan(plannedCalls);
    const compactionIndex = contexts.findIndex((context) =>
      JSON.stringify(context.messages).includes("Create a compact progress checkpoint"),
    );
    expect(compactionIndex).toBeGreaterThan(0);
    const resumed = contexts[compactionIndex + 1]!;
    expect(JSON.stringify(resumed.messages)).toContain("<progress_checkpoint>");
    expect(JSON.stringify(resumed.messages)).not.toContain("Synthetic page evidence");
    expect(events.filter((event) => event.type === "checkpoint")).toEqual([]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Survey complete." },
    ]);
  });

  it("does not install or expose a checkpoint when the run is cancelled", async () => {
    const controller = new AbortController();
    const contexts: Context[] = [];
    let calls = 0;
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      contexts.push(structuredClone(context));
      if (JSON.stringify(context.messages).includes("Create a compact progress checkpoint")) {
        controller.abort();
        return response(
          assistant([{ type: "text", text: "This cancelled checkpoint must stay hidden." }]),
        );
      }
      calls += 1;
      return response(
        assistant(
          [
            {
              type: "toolCall",
              id: `call-${calls}`,
              name: "computer_act",
              arguments: { step: calls },
            },
          ],
          12_000,
        ),
      );
    });

    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "cancelled-run",
        prompt: "Survey listings in the browser",
        instructions: "Use the computer and keep verified notes.",
        history: [],
        tools: [
          {
            name: "computer_act",
            description: "Perform one browser action",
            inputSchema: { type: "object", properties: {} },
            readOnly: false,
          },
        ],
        model: { provider: model.provider, id: model.id, apiKey: "fixture-key" },
        executeTool: vi.fn(async () => ({
          ok: true,
          page: `Synthetic page evidence ${"detail ".repeat(1_200)}`,
        })),
      } as unknown as AgentRunRequest,
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: controller.signal,
      },
    )) {
      events.push(event);
    }

    expect(
      contexts.some((context) =>
        JSON.stringify(context.messages).includes("Create a compact progress checkpoint"),
      ),
    ).toBe(true);
    expect(JSON.stringify(contexts)).not.toContain("<progress_checkpoint>");
    expect(JSON.stringify(events)).not.toContain("This cancelled checkpoint must stay hidden.");
  });

  it("locks real tools during checkpointing and returns a partial result when it fails", async () => {
    const contexts: Context[] = [];
    let normalCalls = 0;
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      contexts.push(structuredClone(context));
      const wire = JSON.stringify(context.messages);
      if (wire.includes("The progress checkpoint could not be created")) {
        return response(
          assistant([{ type: "text", text: "Verified one page; the rest is pending." }]),
        );
      }
      if (wire.includes("Create a compact progress checkpoint")) {
        return response(
          assistant([
            {
              type: "toolCall",
              id: "forbidden-checkpoint-call",
              name: "computer_act",
              arguments: { step: 999 },
            },
          ]),
        );
      }
      normalCalls += 1;
      return response(
        assistant(
          [
            {
              type: "toolCall",
              id: `normal-call-${normalCalls}`,
              name: "computer_act",
              arguments: { step: normalCalls },
            },
          ],
          12_000,
        ),
      );
    });
    const executeTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      ok: true,
      evidence: "recorded page",
    }));
    const events: AgentRuntimeEvent[] = [];

    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "failed-checkpoint-run",
        prompt: "Survey listings in the browser",
        instructions: "Use the computer and keep verified notes.",
        history: [],
        tools: [
          {
            name: "computer_act",
            description: "Perform one browser action",
            inputSchema: { type: "object", properties: {} },
            readOnly: false,
          },
        ],
        model: { provider: model.provider, id: model.id, apiKey: "fixture-key" },
        executeTool,
      } as unknown as AgentRunRequest,
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(
      executeTool.mock.calls.some(([, args]) => (args as { step?: number }).step === 999),
    ).toBe(false);
    expect(
      contexts.find((context) => JSON.stringify(context.messages).includes("Create a compact"))
        ?.tools ?? [],
    ).toEqual([]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Verified one page; the rest is pending." },
    ]);
    expect(JSON.stringify(events)).not.toContain("forbidden-checkpoint-call");
  });

  it("waits for meaningful context growth before another checkpoint", async () => {
    const contexts: Context[] = [];
    let workStep = 0;
    let compacted = false;
    let workAfterCompaction = 0;
    providerState.stream.mockImplementation((_model: unknown, context: Context) => {
      contexts.push(structuredClone(context));
      const wire = JSON.stringify(context.messages);
      if (wire.includes("Create a compact progress checkpoint")) {
        compacted = true;
        return response(
          assistant([{ type: "text", text: "Completed step one. Next: step two." }], 12_000),
        );
      }
      if (wire.includes("<progress_checkpoint>") && workAfterCompaction === 0) {
        workAfterCompaction += 1;
        return response(
          assistant(
            [{ type: "toolCall", id: "after-compact", name: "computer_act", arguments: {} }],
            12_500,
          ),
        );
      }
      if (compacted) {
        return response(assistant([{ type: "text", text: "Done after one checkpoint." }], 13_000));
      }
      const current = workStep++;
      return response(
        assistant(
          [
            {
              type: "toolCall",
              id: `before-compact-${current}`,
              name: "computer_act",
              arguments: {},
            },
          ],
          1_000 + current * 500,
        ),
      );
    });

    const events: AgentRuntimeEvent[] = [];
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "checkpoint-growth-run",
        prompt: "Survey listings in the browser",
        instructions: "Use the computer and keep verified notes.",
        history: [],
        tools: [
          {
            name: "computer_act",
            description: "Perform one browser action",
            inputSchema: { type: "object", properties: {} },
            readOnly: false,
          },
        ],
        model: { provider: model.provider, id: model.id, apiKey: "fixture-key" },
        executeTool: vi.fn(async () => ({
          ok: true,
          evidence: `recorded page ${"detail ".repeat(1_200)}`,
        })),
      } as unknown as AgentRunRequest,
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    expect(
      contexts.filter((context) =>
        JSON.stringify(context.messages).includes("Create a compact progress checkpoint"),
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Done after one checkpoint." },
    ]);
  });
});
