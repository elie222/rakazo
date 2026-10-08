import type * as AgentCore from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  CredentialStore,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, AgentRuntimeEvent, ModelCallObserver } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  credentialStores: [] as unknown[],
  stream: vi.fn(),
  agentOptions: undefined as AgentOptions | undefined,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCore>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: AgentOptions) {
        super(options);
        providerState.agentOptions = options;
      }
    },
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: (options?: { credentials?: unknown }) => {
    if (options?.credentials) providerState.credentialStores.push(options.credentials);
    return {
      getModel: (provider: string, id: string) => providerState.models.get(`${provider}/${id}`),
      streamSimple: (...args: unknown[]) => providerState.stream(...args),
    };
  },
}));

vi.mock("./pi-current-models.js", () => ({ supplementPiModels: (models: unknown) => models }));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import { isRetryableProviderUnavailable, PiAgentRuntime } from "./pi-runtime.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { PiJsonlSessionRecorder } from "./pi-session.js";

const primary = model("provider-a", "primary", 32_768);
const backupA = model("provider-b", "backup-a", 8_192);
const backupB = model("provider-c", "backup-b", 16_384);

function model(provider: string, id: string, contextWindow: number): Model<"openai-completions"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://models.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(4_096, contextWindow),
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

function stream(_target: Model<"openai-completions">, response: AssistantMessage) {
  const result = new AssistantMessageEventStream();
  result.push({ type: "start", partial: { ...response, content: [], stopReason: "stop" } });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    result.push({
      type: "error",
      reason: response.stopReason,
      error: response,
    });
  } else if (response.content.some((part) => part.type === "toolCall")) {
    const call = response.content.find((part) => part.type === "toolCall");
    if (call?.type === "toolCall") {
      result.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...response, content: [] },
      });
      result.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call,
        partial: response,
      });
    }
    result.push({ type: "done", reason: "toolUse", message: response });
  } else {
    result.push({ type: "done", reason: "stop", message: response });
  }
  result.end(response);
  return result;
}

function countContextImages(context: { messages?: unknown[] }): number {
  let count = 0;
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object" || !("content" in message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    count += content.filter(
      (part) =>
        part !== null && typeof part === "object" && (part as { type?: unknown }).type === "image",
    ).length;
  }
  return count;
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

async function run(
  input: AgentRunRequest,
  events: AgentRuntimeEvent[] = [],
  runtime = new PiAgentRuntime(),
) {
  for await (const event of runtime.run(input, {
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

beforeEach(() => {
  providerState.models.clear();
  providerState.credentialStores.length = 0;
  for (const candidate of [primary, backupA, backupB]) {
    providerState.models.set(
      `${candidate.provider}/${candidate.id}`,
      candidate as unknown as Record<string, unknown>,
    );
  }
  providerState.stream.mockReset();
  providerState.agentOptions = undefined;
  vi.restoreAllMocks();
});

describe("Pi runtime ordered model fallback", () => {
  it.each(["absent", "empty"])(
    "passes the original stream options and terminal content through with %s backups",
    async (backups) => {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [{ type: "text", text: "healthy" }], "stop")),
      );
      const input = request();
      if (backups === "absent") delete input.fallbackModels;
      await run(input);
      const agentOptions = providerState.agentOptions;
      if (!agentOptions) throw new Error("Agent was not created");
      expect(await agentOptions.getApiKey?.(primary.provider)).toBe("fake-primary-key");

      const upstream = new AssistantMessageEventStream();
      providerState.stream.mockReturnValue(upstream);
      const signal = new AbortController().signal;
      const options = {
        apiKey: "caller-key",
        reasoning: "high" as const,
        maxTokens: 123,
        timeoutMs: 456,
        maxRetries: 2,
        headers: { "x-fixture": "unchanged" },
        signal,
      };
      const response = await agentOptions.streamFn(
        primary,
        { messages: [] } as unknown as TranscriptContext,
        options,
      );
      const iterator = response[Symbol.asyncIterator]();
      const first = iterator.next();
      const failure = message(
        primary,
        [{ type: "text", text: "partial result" }],
        "error",
        "503 overloaded",
      );
      const start = { type: "start" as const, partial: { ...failure, content: [] } };
      upstream.push(start);
      // A buffering wrapper would wait for output or termination here.
      expect((await first).value).toBe(start);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject(options);
      upstream.push({ type: "error", reason: "error", error: failure });
      upstream.end(failure);
      expect((await iterator.next()).value).toEqual({
        type: "error",
        reason: "error",
        error: failure,
      });
      expect(await response.result()).toBe(failure);
    },
  );

  it("preserves OAuth getApiKey behavior with no backup list", async () => {
    const input = request();
    delete input.fallbackModels;
    delete input.model.apiKey;
    input.model.oauth = {
      credential: {
        type: "oauth",
        access: "fake-user-access",
        refresh: "fake-user-refresh",
        expires: Date.now() + 60_000,
      },
    };
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "answer" }], "stop")),
    );
    await run(input);
    expect(await providerState.agentOptions?.getApiKey?.(primary.provider)).toBeUndefined();
    expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({ apiKey: undefined });
  });

  it("skips a backup with no user credential even when a process key is set", async () => {
    const unconnected = model("openrouter", "unconnected", 16_384);
    providerState.models.set(
      `${unconnected.provider}/${unconnected.id}`,
      unconnected as unknown as Record<string, unknown>,
    );
    vi.stubEnv("OPENROUTER_API_KEY", "fake-process-key");
    try {
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, message(target, [], "error", "429 rate limit"))
          : stream(target, message(target, [{ type: "text", text: "backup" }], "stop")),
      );
      await run(
        request([
          { provider: unconnected.provider, id: unconnected.id },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-user-backup-key" },
        ]),
      );
      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([primary.provider, backupB.provider]);
      expect(providerState.stream.mock.lastCall?.[2]).toMatchObject({
        apiKey: "fake-user-backup-key",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "bills configured model ids with switched=%s despite provider response ids",
    async (switched) => {
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => "reservation");
      const afterCall = vi.fn<ModelCallObserver["afterCall"]>(async () => undefined);
      const onUsage = vi.fn<NonNullable<AgentRunRequest["onUsage"]>>(async () => undefined);
      const input = request(
        switched ? [{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }] : [],
      );
      input.onUsage = onUsage;
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        const failure = switched && target.provider === primary.provider;
        const result = message(
          target,
          failure ? [] : [{ type: "text", text: "answer" }],
          failure ? "error" : "stop",
          failure ? "429 rate limit" : undefined,
        );
        result.provider = "reported-provider";
        result.model = "reported-model";
        result.responseModel = "reported-model-2026-10-08";
        return stream(target, result);
      });
      const events = await run(
        input,
        [],
        new PiAgentRuntime({ modelCallObserver: { beforeCall, afterCall } }),
      );
      const targets = switched ? [primary, backupA] : [primary];
      expect(beforeCall.mock.calls.map(([call]) => call)).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, modelId: target.id }),
        ),
      );
      expect(onUsage.mock.calls.map(([event]) => event)).toEqual(
        targets.map((target) =>
          expect.objectContaining({
            provider: target.provider,
            model: target.id,
            inputTokens: 4,
            outputTokens: 2,
          }),
        ),
      );
      expect(afterCall).toHaveBeenCalledTimes(targets.length);
      expect(events.filter((event) => event.type === "usage")).toEqual(
        targets.map((target) =>
          expect.objectContaining({ provider: target.provider, model: target.id, accounted: true }),
        ),
      );
    },
  );

  it.each(["reservation", "accounting"])(
    "does not fail over on a local %s timeout",
    async (phase) => {
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const localError = new Error("503 local billing timeout");
      const beforeCall = vi.fn<ModelCallObserver["beforeCall"]>(async () => {
        if (phase === "reservation") throw localError;
        return "reservation";
      });
      if (phase === "accounting")
        input.onUsage = async () => {
          throw localError;
        };
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        stream(target, message(target, [], "error", "429 provider rate limit")),
      );
      await expect(
        run(
          input,
          [],
          new PiAgentRuntime({
            modelCallObserver: { beforeCall, afterCall: async () => undefined },
          }),
        ),
      ).rejects.toThrow(/local billing timeout/);
      expect(providerState.stream).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      expect(beforeCall).toHaveBeenCalledTimes(1);
    },
  );

  it("advances after a provider stream throws before output", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) throw new Error("503 provider unavailable");
      return stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
    });
    const events = await run(
      request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
    );
    expect(events).toContainEqual({ type: "text", text: "backup answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(2);
  });

  it("switches after a Codex idle timeout before output", async () => {
    vi.useFakeTimers();
    try {
      const codex = {
        ...primary,
        provider: "openai-codex",
        api: "openai-codex-responses" as const,
      };
      providerState.models.set(`${codex.provider}/${codex.id}`, codex);
      providerState.stream.mockImplementation(
        (
          target: Model<"openai-completions">,
          _ctx: unknown,
          options: {
            signal: AbortSignal;
            onResponse: (response: Response, model: Model<"openai-completions">) => void;
          },
        ) => {
          if (target.provider !== codex.provider)
            return stream(target, message(target, [{ type: "text", text: "recovered" }], "stop"));
          const result = new AssistantMessageEventStream();
          options.onResponse(new Response(null, { status: 200 }), target);
          options.signal.addEventListener("abort", () => {
            const failure = message(target, [], "aborted", "aborted");
            result.push({ type: "error", reason: "aborted", error: failure });
            result.end(failure);
          });
          return result;
        },
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      input.model.provider = codex.provider;
      const pending = run(input);
      await vi.advanceTimersByTimeAsync(MODEL_STREAM_IDLE_TIMEOUT_MS + 1);
      expect(await pending).toContainEqual({ type: "text", text: "recovered" });
      expect(providerState.stream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records streamed content when the provider iterator throws after output", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "keep this text" }],
      "error",
      "503 timeout",
    );
    providerState.stream.mockImplementation(() => {
      class ThrowingStream extends AssistantMessageEventStream {
        override async *[Symbol.asyncIterator]() {
          yield { type: "start" as const, partial: { ...failure, content: [] } };
          yield {
            type: "text_delta" as const,
            contentIndex: 0,
            delta: "keep this text",
            partial: failure,
          };
          throw new Error("503 timeout");
        }
      }
      return new ThrowingStream();
    });
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(
        request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]),
        events,
        new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
      ),
    ).rejects.toThrow(/503 timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("keep this text");
  });

  it("keeps terminal-only partial text even when usage accounting fails", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal answer" }],
      "error",
      "503 unavailable",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    input.onUsage = async () => {
      throw new Error("local accounting timeout");
    };
    const appendMessage = vi.fn(async () => undefined);
    vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
    const events: AgentRuntimeEvent[] = [];
    await expect(
      run(input, events, new PiAgentRuntime({ sessionRoot: "fixture-sessions" })),
    ).rejects.toThrow(/local accounting timeout/);
    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", content: failure.content }),
    );
    expect(events).toContainEqual({ type: "text", text: "terminal answer" });
  });

  it("continues after a long-retry 429 on a smaller backup without replaying a completed tool effect", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    const executeTool = vi.mocked(input.executeTool!);
    let primaryCalls = 0;
    let backupContext: { messages?: unknown[] } | undefined;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          primaryCalls += 1;
          if (primaryCalls === 1) {
            const call = {
              type: "toolCall" as const,
              id: "write-once",
              name: "write_effect",
              arguments: { value: "persist this once" },
            };
            return stream(target, message(target, [call], "toolUse"));
          }
          return stream(
            target,
            message(
              target,
              [],
              "error",
              "Server requested 3301s retry delay (max:60s). 429 rate_limit_error",
            ),
          );
        }
        backupContext = context;
        return stream(
          target,
          message(target, [{ type: "text", text: "Finished safely." }], "stop"),
        );
      },
    );

    const events = await run(input);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(primaryCalls).toBe(2);
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider, backupA.provider]);
    expect(JSON.stringify(backupContext?.messages)).toContain("write-once");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "Finished safely." }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: backupA.provider, model: backupA.id }),
    );
  });

  it("keeps the primary on a healthy response and leaves an empty chain unchanged", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [{ type: "text", text: "Primary response." }], "stop")),
    );

    const events = await run(request());

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(providerState.stream.mock.calls[0]?.[0]).toMatchObject({ provider: primary.provider });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "usage", provider: primary.provider, model: primary.id }),
    );
  });

  it("keeps helper-model selection on the active backup after the primary fails", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "backup-fixture-key" },
    ]);
    input.model.apiKey = "primary-fixture-key";
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    const providers: string[] = [];
    const apiKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        providers.push(target.provider);
        apiKeys.push(options?.apiKey);
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        if (backupCalls === 1) {
          return stream(
            target,
            message(
              target,
              [
                {
                  type: "toolCall",
                  id: "helper-call",
                  name: "run_subagent",
                  arguments: { name: "helper", task: "Summarize the fixture." },
                },
              ],
              "toolUse",
            ),
          );
        }
        return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
      },
    );

    await run(input);

    expect(providers).toEqual([
      primary.provider,
      backupA.provider,
      backupA.provider,
      backupA.provider,
    ]);
    expect(apiKeys).toEqual([
      "primary-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
      "backup-fixture-key",
    ]);
  });

  it("keeps a refreshed backup OAuth token for later helper calls", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.tools = [
      {
        name: "run_subagent",
        description: "Run a helper agent.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, task: { type: "string" } },
          required: ["name", "task"],
        },
        readOnly: true,
      },
    ];
    input.resolveFallbackModel = vi.fn(async () => ({
      provider: backupA.provider,
      id: backupA.id,
      oauth: {
        credential: {
          type: "oauth" as const,
          access: "backup-access-before-refresh",
          refresh: "backup-refresh",
          expires: Date.now() + 60_000,
        },
      },
    }));
    const backupKeys: Array<string | undefined> = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupKeys.push(options?.apiKey);
        if (backupCalls !== 1) {
          return stream(target, message(target, [{ type: "text", text: "Complete." }], "stop"));
        }
        const credentialStore = providerState.credentialStores[0] as CredentialStore;
        const response = message(
          target,
          [
            {
              type: "toolCall",
              id: "oauth-helper-call",
              name: "run_subagent",
              arguments: { name: "helper", task: "Summarize the fixture." },
            },
          ],
          "toolUse",
        );
        const output = new AssistantMessageEventStream();
        void (async () => {
          await credentialStore.modify(backupA.provider, async (current) => {
            if (current?.type !== "oauth") throw new Error("OAuth credential missing in fixture");
            return { ...current, access: "backup-access-after-refresh" };
          });
          for await (const event of stream(target, response)) output.push(event);
          output.end(response);
        })();
        return output;
      },
    );

    const events = await run(input);

    expect(backupKeys).toEqual([
      "backup-access-before-refresh",
      "backup-access-after-refresh",
      "backup-access-after-refresh",
    ]);
    expect(JSON.stringify(events)).not.toContain("backup-access-before-refresh");
    expect(JSON.stringify(events)).not.toContain("backup-access-after-refresh");
  });

  it("persists the selected model before streaming from the backup", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    let modelChangePersisted = false;
    input.onModelChange = vi.fn(async () => {
      await Promise.resolve();
      modelChangePersisted = true;
    });
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      if (target.provider === primary.provider) {
        return stream(target, message(target, [], "error", "429 rate_limit_error"));
      }
      expect(modelChangePersisted).toBe(true);
      return stream(target, message(target, [{ type: "text", text: "backup response" }], "stop"));
    });

    const events = await run(input);

    expect(input.onModelChange).toHaveBeenCalledExactlyOnceWith(backupA.provider, backupA.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        text: expect.stringContaining(backupA.id),
      }),
    );
  });

  it("prunes new screenshots using the active backup image limit", async () => {
    const visionBackup = { ...backupA, input: ["text", "image"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, visionBackup);
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    input.resolveFallbackModel = async () => ({
      provider: backupA.provider,
      id: backupA.id,
      apiKey: "test-key",
      maxImagesPerPrompt: 1,
    });
    input.tools = [
      {
        name: "computer_observe",
        description: "Read the screen",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    input.executeTool = vi.fn(async () => ({
      kind: "agent_tool_result",
      content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
      details: { frameId: "test-frame" },
    }));
    let calls = 0;
    const counts: number[] = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: Context) => {
        if (target.provider === primary.provider)
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        counts.push(
          context.messages.reduce(
            (total, item) =>
              total +
              (typeof item.content === "string"
                ? 0
                : item.content.filter((part) => part.type === "image").length),
            0,
          ),
        );
        calls += 1;
        return calls <= 2
          ? stream(
              target,
              message(
                target,
                [
                  {
                    type: "toolCall",
                    id: `frame-${calls}`,
                    name: "computer_observe",
                    arguments: {},
                  },
                ],
                "toolUse",
              ),
            )
          : stream(target, message(target, [{ type: "text", text: "Done" }], "stop"));
      },
    );
    await run(input);
    expect(counts).toEqual([0, 1, 1]);
    expect(input.executeTool).toHaveBeenCalledTimes(2);
  });

  it("preserves terminal partial text while refusing unsafe failover", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "partial answer" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation(() => stream(primary, failure));
    const events: AgentRuntimeEvent[] = [];
    await expect(run(request(), events)).rejects.toThrow(/429 rate_limit_error/);
    expect(events).toContainEqual({ type: "text", text: "partial answer" });
    expect(providerState.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "records streamed output and terminal suffixes with emptyTerminal=%s",
    async (emptyTerminal) => {
      const targetMessage = message(
        primary,
        [{ type: "text", text: "partial plus terminal suffix" }],
        "error",
        "429 rate_limit_error",
      );
      providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
        if (target.provider === primary.provider) {
          const result = new AssistantMessageEventStream();
          const partial = { ...targetMessage, content: [] };
          result.push({ type: "start", partial });
          result.push({ type: "text_start", contentIndex: 0, partial });
          result.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: { ...targetMessage, content: [{ type: "text", text: "partial" }] },
          });
          const terminal = emptyTerminal ? { ...targetMessage, content: [] } : targetMessage;
          result.push({ type: "error", reason: "error", error: terminal });
          result.end(terminal);
          return result;
        }
        return stream(target, message(target, [{ type: "text", text: "must not run" }], "stop"));
      });

      const appendMessage = vi.fn(async () => undefined);
      vi.spyOn(PiJsonlSessionRecorder.prototype, "start").mockResolvedValue({ appendMessage });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        run(
          request([{ provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" }]),
          events,
          new PiAgentRuntime({ sessionRoot: "fixture-sessions" }),
        ),
      ).rejects.toThrow(/429 rate_limit_error/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      expect(appendMessage).toHaveBeenCalledWith(
        emptyTerminal
          ? { ...targetMessage, content: [{ type: "text", text: "partial" }] }
          : targetMessage,
      );
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(emptyTerminal ? "partial" : "partial plus terminal suffix");
    },
  );

  it("keeps terminal error text when nothing was streamed and does not switch", async () => {
    const failure = message(
      primary,
      [{ type: "text", text: "terminal partial" }],
      "error",
      "429 rate_limit_error",
    );
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, failure)
        : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
    );
    const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
    const events: Array<{ type: string; text?: string }> = [];
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      for await (const event of runtime.run(input, {
        operationId: "operation",
        traceId: "trace",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      })) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

    expect(providerState.stream).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text", text: "terminal partial" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "text", text: "must not run" }),
    );
  });

  it("prunes later screenshots with the active backup image limit", async () => {
    const input = request([
      {
        provider: backupA.provider,
        id: backupA.id,
        apiKey: "backup-key",
        maxImagesPerPrompt: 1,
      },
    ]);
    input.model = { ...input.model, maxImagesPerPrompt: 3 };
    input.tools = [
      {
        name: "computer_observe",
        description: "Observe the computer",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    let shots = 0;
    input.executeTool = vi.fn(async () => {
      shots += 1;
      return {
        kind: "agent_tool_result" as const,
        content: [
          { type: "text" as const, text: `frame ${shots}` },
          { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const },
        ],
        details: { frameId: `frame-${shots}` },
      };
    });
    const backupImageCounts: number[] = [];
    let backupCalls = 0;
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, context: { messages?: unknown[] }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        backupCalls += 1;
        backupImageCounts.push(countContextImages(context));
        if (backupCalls <= 3) {
          const call = {
            type: "toolCall" as const,
            id: `observe-${backupCalls}`,
            name: "computer_observe",
            arguments: {},
          };
          return stream(target, message(target, [call], "toolUse"));
        }
        return stream(target, message(target, [{ type: "text", text: "done looking" }], "stop"));
      },
    );

    await run(input);

    expect(backupCalls).toBe(4);
    expect(backupImageCounts[0]).toBe(0);
    expect(backupImageCounts.at(-1)).toBe(1);
  });

  it.each([
    {
      label: "thinking",
      content: [{ type: "thinking" as const, thinking: "terminal reasoning" }],
    },
    {
      label: "tool call",
      content: [
        {
          type: "toolCall" as const,
          id: "terminal-call",
          name: "write_effect",
          arguments: { value: "must not execute" },
        },
      ],
    },
  ])(
    "does not switch when the terminal error contains partial $label without deltas",
    async ({ content, label }) => {
      const failure = message(primary, content, "error", "429 rate_limit_error");
      providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
        target.provider === primary.provider
          ? stream(target, failure)
          : stream(target, message(target, [{ type: "text", text: "must not run" }], "stop")),
      );
      const input = request([{ provider: backupA.provider, id: backupA.id, apiKey: "backup-key" }]);
      const events: Array<{ type: string; text?: string }> = [];
      const runtime = new PiAgentRuntime();
      const consume = async () => {
        for await (const event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: new AbortController().signal,
        })) {
          events.push(event);
        }
      };

      await expect(consume()).rejects.toThrow(/429 rate_limit_error/);

      expect(providerState.stream).toHaveBeenCalledTimes(1);
      if (label === "text") {
        expect(events).toContainEqual(
          expect.objectContaining({ type: "text", text: "terminal partial" }),
        );
      }
      expect(input.executeTool).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "text", text: "must not run" }),
      );
      expect(label).toBeTruthy();
    },
  );

  it("does not switch because a tool failed", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
    ]);
    input.executeTool = vi.fn(async () => {
      throw new Error("tool permission denied");
    });
    let primaryCalls = 0;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) => {
      primaryCalls += 1;
      if (primaryCalls === 1) {
        const call = {
          type: "toolCall" as const,
          id: "failed-tool",
          name: "write_effect",
          arguments: { value: "denied" },
        };
        return stream(target, message(target, [call], "toolUse"));
      }
      return stream(
        target,
        message(target, [{ type: "text", text: "The tool was denied." }], "stop"),
      );
    });

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, primary.provider]);
  });

  it("tries backups in order and each only once before surfacing exhaustion", async () => {
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(target, message(target, [], "error", "529 overloaded_error")),
    );

    await expect(
      run(
        request([
          { provider: primary.provider, id: primary.id, apiKey: "duplicate-primary" },
          { provider: backupA.provider, id: backupA.id, apiKey: "fake-backup-a" },
          { provider: backupA.provider, id: backupA.id, apiKey: "duplicate-backup" },
          { provider: backupB.provider, id: backupB.id, apiKey: "fake-backup-b" },
        ]),
      ),
    ).rejects.toThrow(/overloaded_error/);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupA.provider, backupB.provider]);
  });

  it("skips a backup that cannot fit the actual prompt and selects the next smaller-than-primary fit", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "small...key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "fitti...key" },
    ]);
    input.prompt = "x".repeat(8_000);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fit" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("uses a small-context backup when the actual input and configured output fit", async () => {
    const smallContextBackup = model("provider-small", "small-context", 2_048);
    providerState.models.set(
      `${smallContextBackup.provider}/${smallContextBackup.id}`,
      smallContextBackup as unknown as Record<string, unknown>,
    );
    const input = request([
      {
        provider: smallContextBackup.provider,
        id: smallContextBackup.id,
        apiKey: "small...key",
        maxTokens: 512,
      },
    ]);
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "fits" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, smallContextBackup.provider]);
  });

  it("skips backups without the primary turn's reasoning capability", async () => {
    const reasoningPrimary = { ...primary, reasoning: true };
    const textOnlyBackup = { ...backupA, reasoning: false };
    const reasoningBackup = { ...backupB, reasoning: true };
    providerState.models.set(`${primary.provider}/${primary.id}`, reasoningPrimary);
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    providerState.models.set(`${backupB.provider}/${backupB.id}`, reasoningBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "reasoning-key" },
    ]);
    input.model.reasoning = true;
    input.model.thinkingLevel = "high";
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "reasoned" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it.each([...IMAGE_RETURNING_COMPUTER_TOOLS, "write_effect"])(
    "requires image-capable backups only when %s can return screenshots",
    async (toolName) => {
      providerState.models.set(`${backupA.provider}/${backupA.id}`, {
        ...backupA,
        input: ["text"],
      });
      const input = request([
        { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
        { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
      ]);
      input.tools = [{ ...input.tools[0]!, name: toolName }];
      providerState.stream.mockImplementation(
        (target: Model<"openai-completions">, context: Context) => {
          expect(countContextImages(context)).toBe(0);
          return target.provider === primary.provider
            ? stream(target, message(target, [], "error", "429 rate_limit_error"))
            : stream(target, message(target, [{ type: "text", text: "backup answer" }], "stop"));
        },
      );

      await run(input);

      expect(
        providerState.stream.mock.calls.map(
          ([target]) => (target as Model<"openai-completions">).provider,
        ),
      ).toEqual([
        primary.provider,
        IMAGE_RETURNING_COMPUTER_TOOLS.has(toolName) ? backupB.provider : backupA.provider,
      ]);
    },
  );

  it("skips backups that cannot accept the current image input", async () => {
    const textOnlyBackup = { ...backupA, input: ["text"] as ["text"] };
    providerState.models.set(`${backupA.provider}/${backupA.id}`, textOnlyBackup);
    const input = request([
      { provider: backupA.provider, id: backupA.id, apiKey: "text-only-key" },
      { provider: backupB.provider, id: backupB.id, apiKey: "image-backup-key" },
    ]);
    input.currentTurnImages = [
      { name: "fixture.png", mimeType: "image/png", data: new Uint8Array([1]) },
    ];
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      target.provider === primary.provider
        ? stream(target, message(target, [], "error", "429 rate_limit_error"))
        : stream(target, message(target, [{ type: "text", text: "image understood" }], "stop")),
    );

    await run(input);

    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider, backupB.provider]);
  });

  it("does not persist or start a backup when cancellation wins during credential resolution", async () => {
    const input = request([{ provider: backupA.provider, id: backupA.id }]);
    let releaseResolution: ((model: AgentRunRequest["model"]) => void) | undefined;
    input.resolveFallbackModel = vi.fn(
      () =>
        new Promise<AgentRunRequest["model"]>((resolve) => {
          releaseResolution = resolve;
        }),
    );
    const onModelChange = vi.fn(async () => undefined);
    input.onModelChange = onModelChange;
    providerState.stream.mockImplementation((target: Model<"openai-completions">) =>
      stream(
        target,
        target.provider === primary.provider
          ? message(target, [], "error", "429 rate_limit_error")
          : message(target, [{ type: "text", text: "must not start" }], "stop"),
      ),
    );
    const controller = new AbortController();
    const runtime = new PiAgentRuntime();
    const consume = async () => {
      try {
        for await (const _event of runtime.run(input, {
          operationId: "operation",
          traceId: "trace",
          spaceId: "space",
          userId: "user",
          signal: controller.signal,
        })) {
          // Drain the runtime stream while cancellation is tested.
        }
      } catch {
        // Cancellation is surfaced as a stopped run by the outer runtime.
      }
    };
    const running = consume();
    await vi.waitFor(() => expect(input.resolveFallbackModel).toHaveBeenCalledOnce());
    controller.abort();
    releaseResolution?.({ provider: backupA.provider, id: backupA.id, apiKey: "test-backup-key" });
    await running;

    expect(onModelChange).not.toHaveBeenCalled();
    expect(
      providerState.stream.mock.calls.map(
        ([target]) => (target as Model<"openai-completions">).provider,
      ),
    ).toEqual([primary.provider]);
  });

  it("skips a backup with changed credentials and uses only the next backup's credential", async () => {
    const input = request([
      { provider: backupA.provider, id: backupA.id },
      { provider: backupB.provider, id: backupB.id },
    ]);
    const resolveFallbackModel = vi.fn(async (provider: string, id: string) => {
      if (provider === backupA.provider) throw new Error("connected credential changed");
      return { provider, id, apiKey: "backup-only-key" };
    });
    input.resolveFallbackModel = resolveFallbackModel;
    const requestKeys: Array<string | undefined> = [];
    providerState.stream.mockImplementation(
      (target: Model<"openai-completions">, _context: unknown, options?: { apiKey?: string }) => {
        if (target.provider === primary.provider) {
          return stream(target, message(target, [], "error", "429 rate_limit_error"));
        }
        requestKeys.push(options?.apiKey);
        return stream(target, message(target, [{ type: "text", text: "safe" }], "stop"));
      },
    );

    const events = await run(input);

    expect(resolveFallbackModel).toHaveBeenNthCalledWith(1, backupA.provider, backupA.id);
    expect(resolveFallbackModel).toHaveBeenNthCalledWith(2, backupB.provider, backupB.id);
    expect(requestKeys).toEqual(["backup-only-key"]);
    expect(JSON.stringify(events)).not.toContain("backup-only-key");
  });
});

describe("provider availability classification", () => {
  it.each([
    [
      "HTTP 400 before retry text",
      { status: 400, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 401 before retry text",
      { statusCode: 401, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 403 before retry text",
      { httpStatus: 403, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "unprocessable input before retry text",
      { status: 422, message: "The request cannot be processed; 429 rate limit" },
      false,
    ],
    [
      "cancellation",
      new Error("user cancelled request; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "consent refusal",
      new Error("user declined consent; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    ["quota exhaustion", { status: 402, message: "provider quota exhausted" }, true],
    ["plain status", new Error("503 provider unavailable"), true],
    ["HTTP server status", new Error("HTTP 500"), true],
    ["context overflow", new Error("context_length_exceeded; retry after 60s"), false],
    ["transient server failure", { status: 503, message: "service unavailable" }, true],
  ])("classifies %s", (_label, error, expected) => {
    expect(isRetryableProviderUnavailable(error)).toBe(expected);
  });
});
