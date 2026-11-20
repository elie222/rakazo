import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ModelEscalation,
  ModelEscalationStep,
} from "@rakazo/adapter-kit";
import type * as Core from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  stream: vi.fn(),
  delay: vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(),
}));

vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  abortableDelay: providerState.delay,
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
    streamSimple: (...args: unknown[]) => providerState.stream(...args),
  }),
}));

vi.mock("./models/pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));
vi.mock("./models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const primary = model("provider-a", "primary");
const backupA = model("provider-b", "backup-a");
const backupB = model("provider-c", "backup-b");

function model(provider: string, id: string): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function message(
  target: Model<"openai-completions">,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: target.api,
    provider: target.provider,
    model: target.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function stream(response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  const call = response.content.find((part) => part.type === "toolCall");
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({ type: "error", reason: response.stopReason, error: response });
  } else if (call) {
    result.push({ type: "toolcall_start", contentIndex: 0, partial: { ...response, content: [] } });
    result.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: response });
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function toolCall(
  target: Model<"openai-completions">,
  id: string,
  args: Record<string, string> = { value: id },
) {
  return stream(
    message(target, [{ type: "toolCall", id, name: "write_effect", arguments: args }], "toolUse"),
  );
}

function done(target: Model<"openai-completions">, text: string) {
  return stream(message(target, [{ type: "text", text }], "stop"));
}

function failing(target: Model<"openai-completions">) {
  return stream(message(target, [], "error", "Connection error."));
}

function request(fallbackModels: AgentRunRequest["model"][] = []): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Write the requested result",
    instructions: "Use tools when useful.",
    history: [],
    tools: [
      {
        name: "write_effect",
        description: "Write one external effect.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        readOnly: false,
      },
    ],
    model: { provider: primary.provider, id: primary.id, apiKey: "fake-primary-key" },
    fallbackModels,
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

function escalation(
  steps: Array<ModelEscalationStep | undefined>,
): ModelEscalation & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    observeToolCall: (name) => calls.push(`call:${name}`),
    observeToolResult: (name, result) => calls.push(`result:${name}:${result.isError}`),
    next: () => steps.shift(),
    resolve: async (provider, id) => ({ provider, id, apiKey: "fake-escalation-key" }),
  };
}

const streamedIds = () => providerState.stream.mock.calls.map(([target]) => target.id);

beforeEach(() => {
  providerState.models.clear();
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  vi.restoreAllMocks();
  providerState.delay.mockReset().mockResolvedValue(undefined);
});

describe("Pi runtime model escalation between turns", () => {
  it("moves the run to the requested model after a tool turn, with the transcript carried over", async () => {
    const input = request();
    const esc = escalation([
      { model: { provider: backupA.provider, id: backupA.id }, reason: "x" },
    ]);
    const onModelChange = vi.fn(async () => undefined);
    Object.assign(input, { modelEscalation: esc, onModelChange });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(backupA, "Done on the stronger model."));

    const events = await run(input);

    expect(events).toContainEqual({ type: "text", text: "Done on the stronger model." });
    expect(streamedIds()).toEqual([primary.id, backupA.id]);
    const sent = JSON.stringify(providerState.stream.mock.calls[1]?.[1].messages);
    expect(sent).toContain("first-call");
    expect(sent).toContain("Write the requested result");
    expect(providerState.stream.mock.calls[1]?.[2].apiKey).toBe("fake-escalation-key");
    expect(onModelChange).toHaveBeenCalledWith(backupA.provider, backupA.id);
    expect(esc.calls).toEqual(["call:write_effect", "result:write_effect:false"]);
  });

  it("adds a note step to the next request and keeps the model", async () => {
    const input = request();
    Object.assign(input, {
      modelEscalation: escalation([{ note: "NOTE-FOR-MODEL", reason: "x" }]),
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Noted."));

    await run(input);

    expect(streamedIds()).toEqual([primary.id, primary.id]);
    expect(JSON.stringify(providerState.stream.mock.calls[1]?.[1].messages)).toContain(
      "NOTE-FOR-MODEL",
    );
  });

  it("tells the hook once when the requested model is not available, and the run stays", async () => {
    const input = request();
    const failed = vi.fn();
    Object.assign(input, {
      modelEscalation: {
        ...escalation([{ model: { provider: "nowhere", id: "missing" }, reason: "x" }]),
        failed,
      },
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Stayed."));

    expect(await run(input)).toContainEqual({ type: "text", text: "Stayed." });
    expect(streamedIds()).toEqual([primary.id, primary.id]);
    expect(failed).toHaveBeenCalledExactlyOnceWith("missing");
  });

  it("tells the hook when it resolves a different model than the step named", async () => {
    const input = request();
    const failed = vi.fn();
    Object.assign(input, {
      modelEscalation: {
        ...escalation([{ model: { provider: backupA.provider, id: backupA.id }, reason: "x" }]),
        resolve: async () => ({ provider: backupB.provider, id: backupB.id, apiKey: "fake-key" }),
        failed,
      },
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Stayed."));

    expect(await run(input)).toContainEqual({ type: "text", text: "Stayed." });
    expect(streamedIds()).toEqual([primary.id, primary.id]);
    expect(failed).toHaveBeenCalledExactlyOnceWith(backupA.id);
  });

  it("tells the hook once when resolving the model throws, and the run stays", async () => {
    const input = request();
    const failed = vi.fn();
    Object.assign(input, {
      modelEscalation: {
        ...escalation([{ model: { provider: backupA.provider, id: backupA.id }, reason: "x" }]),
        resolve: async () => {
          throw new Error("refused");
        },
        failed,
      },
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Stayed."));

    expect(await run(input)).toContainEqual({ type: "text", text: "Stayed." });
    expect(streamedIds()).toEqual([primary.id, primary.id]);
    expect(failed).toHaveBeenCalledExactlyOnceWith(backupA.id);
  });

  it("tells the hook once when switching to the model throws, and the run stays", async () => {
    const input = request();
    const failed = vi.fn();
    Object.assign(input, {
      modelEscalation: {
        ...escalation([{ model: { provider: backupA.provider, id: backupA.id }, reason: "x" }]),
        failed,
      },
      onModelChange: vi.fn(async () => {
        throw new Error("switch refused");
      }),
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Stayed."));

    expect(await run(input)).toContainEqual({ type: "text", text: "Stayed." });
    expect(streamedIds()).toEqual([primary.id, primary.id]);
    expect(failed).toHaveBeenCalledExactlyOnceWith(backupA.id);
  });

  it("keeps the run on its model when a hook without failed cannot move", async () => {
    const input = request();
    Object.assign(input, {
      modelEscalation: escalation([{ model: { provider: "nowhere", id: "missing" }, reason: "x" }]),
    });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "first-call"))
      .mockImplementationOnce(() => done(primary, "Stayed."));

    expect(await run(input)).toContainEqual({ type: "text", text: "Stayed." });
    expect(streamedIds()).toEqual([primary.id, primary.id]);
  });

  it("sends the same requests with an idle hook as without one", async () => {
    const calls = async (withHook: boolean) => {
      providerState.stream.mockReset();
      const input = request();
      if (withHook) Object.assign(input, { modelEscalation: escalation([]) });
      providerState.stream
        .mockImplementationOnce(() => toolCall(primary, "first-call"))
        .mockImplementationOnce(() => done(primary, "Same."));
      await run(input);
      return providerState.stream.mock.calls.map(([target, context, options]) => ({
        model: target.id,
        messages: JSON.stringify(context.messages.map((m: { role: string }) => m.role)),
        apiKey: options?.apiKey,
      }));
    };
    const without = await calls(false);
    const idle = await calls(true);
    expect(without).toHaveLength(2);
    expect(idle).toEqual(without);
  });

  it("reports a tool call whose arguments fail the schema as an error result", async () => {
    const input = request();
    const results: Array<{ isError: boolean; text: string }> = [];
    const esc = escalation([]);
    esc.observeToolResult = (_name, result) =>
      results.push({ isError: result.isError, text: result.text });
    Object.assign(input, { modelEscalation: esc });
    providerState.stream
      .mockImplementationOnce(() => toolCall(primary, "bad", {}))
      .mockImplementationOnce(() => done(primary, "ok"));

    await run(input);

    expect(input.executeTool).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain("write_effect");
  });
});

describe("Pi runtime fallback with a model escalation hook", () => {
  const up = { model: { provider: backupB.provider, id: backupB.id }, reason: "x" };

  function withFallbackSpy(input: AgentRunRequest, steps: Array<ModelEscalationStep | undefined>) {
    const onFallback = vi.fn();
    Object.assign(input, {
      modelEscalation: { ...escalation(steps), onFallback },
      onModelChange: vi.fn(async () => undefined),
    });
    return onFallback;
  }

  it("falls back to the model the run left when the new model fails and there are no backups", async () => {
    const input = request();
    const onFallback = withFallbackSpy(input, [up]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (providerState.stream.mock.calls.length === 1) return toolCall(primary, "first-call");
      if (target.id === backupB.id) return failing(backupB);
      return done(target, "Finished on the model left.");
    });

    const events = await run(input);

    expect(events).toContainEqual({ type: "text", text: "Finished on the model left." });
    const ids = streamedIds();
    expect(ids[0]).toBe(primary.id);
    expect(ids).toContain(backupB.id);
    expect(ids.at(-1)).toBe(primary.id);
    expect(onFallback).toHaveBeenCalledWith(primary.provider, primary.id);
    expect(JSON.stringify(providerState.stream.mock.calls.at(-1)?.[1].messages)).toContain(
      "first-call",
    );
  });

  it("tries the model the run left first, then the run's backups", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const onFallback = withFallbackSpy(input, [up]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (providerState.stream.mock.calls.length === 1) return toolCall(primary, "first-call");
      if (target.id === backupA.id) return done(backupA, "Finished on the backup.");
      return failing(target);
    });

    const events = await run(input);

    expect(events).toContainEqual({ type: "text", text: "Finished on the backup." });
    const after = streamedIds().slice(1);
    const firstLeft = after.indexOf(primary.id);
    expect(after[0]).toBe(backupB.id);
    expect(firstLeft).toBeGreaterThan(0);
    expect(after.indexOf(backupA.id)).toBeGreaterThan(firstLeft);
    expect(onFallback.mock.calls.map(([, id]) => id)).toEqual([primary.id, backupA.id]);
  });

  it("reports a fallback that happens before any move", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const onFallback = withFallbackSpy(input, []);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.id === primary.id ? failing(primary) : done(target, "Finished on the backup."),
    );

    expect(await run(input)).toContainEqual({ type: "text", text: "Finished on the backup." });
    expect(onFallback.mock.calls.map(([, id]) => id)).toEqual([backupA.id]);
  });

  it("does not try again a model the run already left before the move", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const onFallback = withFallbackSpy(input, [up]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      const n = providerState.stream.mock.calls.length;
      if (target.id === primary.id && n === 1) return failing(primary);
      const firstOnA = !providerState.stream.mock.calls
        .slice(0, n - 1)
        .some(([earlier]) => earlier.id === backupA.id);
      if (target.id === backupA.id && firstOnA) return toolCall(backupA, "first-call");
      if (target.id === backupB.id) return failing(backupB);
      return done(target, `Finished on ${target.id}.`);
    });

    const events = await run(input);

    const ids = streamedIds();
    expect(ids.slice(ids.indexOf(backupB.id))).not.toContain(primary.id);
    expect(events).toContainEqual({ type: "text", text: `Finished on ${backupA.id}.` });
    // The fallback to backup A before the move, then the fallback to the model left after it.
    expect(onFallback.mock.calls.map(([, id]) => id)).toEqual([backupA.id, backupA.id]);
  });
});
