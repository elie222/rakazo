import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { normalizePiUsage, observedPiStream, usageReportingFetch } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "openrouter",
  id: "fixture",
  api: "openai-completions",
  name: "fixture",
  baseUrl: "https://model.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};
const sse = (usage?: object) =>
  `${[
    {
      id: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }],
    },
    { id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ id: "test", choices: [], usage }] : []),
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("")}data: [DONE]\n\n`;

async function run(usage?: object) {
  const events: AgentRuntimeEvent[] = [];
  const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
  const afterCall = vi.fn();
  const stream = await observedPiStream(
    builtinModels(),
    model,
    { systemPrompt: "Fixture", messages: [{ role: "user", content: "test", timestamp: 1 }] },
    {
      apiKey: "fake-fixture-key",
      fetch: async () =>
        new Response(sse(usage), { headers: { "content-type": "text/event-stream" } }),
    },
    (event) => events.push(event),
    { beforeCall, afterCall },
  );
  for await (const _event of stream) {
    /* Real Pi provider parser consumes synthetic endpoint. */
  }
  return { events, beforeCall, afterCall, result: await stream.result() };
}

describe("Pi usage accounting", () => {
  it.each([false, true])(
    "acknowledges a producer sink only after successful accounting (fails=%s)",
    async (fails) => {
      const sink = vi.fn(async () => {
        if (fails) throw new Error("Synthetic ledger unavailable");
      });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages: [] },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        undefined,
        { recordUsage: sink },
      );
      for await (const _event of stream) {
      }
      expect(sink).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 2 });
      expect(events[0]?.type === "usage" ? events[0].accounted : undefined).toBe(
        fails ? undefined : true,
      );
    },
  );
  it.each([
    { kind: "answer", afterUser: false, expected: "retrieval" },
    { kind: "answer", afterUser: true, expected: "answer" },
    { kind: "subagent", afterUser: false, expected: "subagent" },
    { kind: "setup", afterUser: false, expected: "setup" },
  ] as const)(
    "attributes history-result consumption to $expected while preserving $kind precedence",
    async ({ kind, afterUser, expected }) => {
      const messages: Context["messages"] = [
        {
          role: "toolResult",
          toolCallId: "history-call",
          toolName: "search_history",
          content: [{ type: "text", text: "Synthetic history" }],
          isError: false,
          timestamp: 1,
        },
      ];
      if (afterUser) messages.push({ role: "user", content: "New task", timestamp: 2 });
      const events: AgentRuntimeEvent[] = [];
      const stream = await observedPiStream(
        builtinModels(),
        model,
        { messages },
        {
          apiKey: "fake-fixture-key",
          fetch: async () =>
            new Response(sse({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }), {
              headers: { "content-type": "text/event-stream" },
            }),
        },
        (event) => events.push(event),
        undefined,
        { operationKind: kind },
      );
      for await (const _event of stream) {
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operationKind: expected, totalTokens: 12 });
    },
  );
  it("attributes a model call requesting history to retrieval without duplicating its usage", async () => {
    const reply = `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "history-call", type: "function", function: { name: "read_history", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`;
    const events: AgentRuntimeEvent[] = [];
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () =>
          new Response(reply, { headers: { "content-type": "text/event-stream" } }),
      },
      (event) => events.push(event),
    );
    for await (const _event of stream) {
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operationKind: "retrieval", totalTokens: 12 });
  });
  it("accounts a cancelled model call even when the event consumer closes before usage arrives", async () => {
    const onUsage = vi.fn();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Pending" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } } })}\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const stream = new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture-cancelled",
          prompt: "Test",
          instructions: "Fixture",
          history: [],
          tools: [],
          onUsage,
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        { signal: AbortSignal.timeout(15000) },
      );
      expect((await stream.next()).value).toMatchObject({ type: "text" });
      await stream.return!();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
        inputTokens: 60,
        outputTokens: 30,
        cacheReadTokens: 40,
        reasoningTokens: 10,
        totalTokens: 130,
        callId: expect.any(String),
      });
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  }, 30000);
  it("settles a thrown provider call before exposing the terminal event", async () => {
    let finishSettlement = () => {};
    const settlement = new Promise<void>((resolve) => {
      finishSettlement = resolve;
    });
    const afterCall = vi.fn(async () => settlement);
    const models = {
      streamSimple: () => {
        throw new Error("Synthetic provider exception");
      },
    } as unknown as Parameters<typeof observedPiStream>[0];
    const stream = await observedPiStream(models, model, { messages: [] }, undefined, vi.fn(), {
      beforeCall: () => "reservation",
      afterCall,
    });
    let terminalSeen = false;
    const next = stream[Symbol.asyncIterator]()
      .next()
      .then((event) => {
        terminalSeen = true;
        return event;
      });
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(terminalSeen).toBe(false);
    finishSettlement();
    expect((await next).value).toMatchObject({ type: "error" });
    expect(afterCall).toHaveBeenCalledWith("reservation", null);
  });
  it("does not derive an unsafe integer total from valid component counts", () => {
    expect(
      normalizePiUsage(
        {
          input: Number.MAX_SAFE_INTEGER,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: Number.MAX_SAFE_INTEGER + 1,
        },
        model,
        new Set(["cacheReadTokens", "cacheWriteTokens"]),
      ).totalTokens,
    ).toBeNull();
  });
  it("keeps fractional or unsafe token counts unknown", () => {
    expect(
      normalizePiUsage({ input: 1.5, output: Number.MAX_SAFE_INTEGER + 1 }, model),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
  it("disables hidden SDK retries for a guarded model call", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Synthetic rate limit", type: "rate_limit" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const afterCall = vi.fn();
    const events: AgentRuntimeEvent[] = [];
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { apiKey: "fake-fixture-key", fetch: fetcher, maxRetries: 3 },
      (event) => events.push(event),
      { beforeCall: () => "reservation", afterCall },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).stopReason).toBe("error");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(afterCall).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });
  it("prepares context before budget reservation and provider execution", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const onUsage = vi.fn(() => {
      throw new Error("telemetry unavailable");
    });
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      {
        apiKey: "fake-fixture-key",
        fetch: async () =>
          new Response(sse({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), {
            headers: { "content-type": "text/event-stream" },
          }),
      },
      vi.fn(),
      { beforeCall, afterCall: vi.fn() },
      undefined,
      { prepareContext: () => ({ messages: [], systemPrompt: "x".repeat(10000) }), onUsage },
    );
    for await (const _event of stream) {
    }
    expect(beforeCall.mock.calls[0]?.[0]).toMatchObject({
      inputTokensEstimate: expect.any(Number),
    });
    expect(beforeCall.mock.calls[0]?.[0]?.inputTokensEstimate).toBeGreaterThan(10000);
    expect(onUsage).toHaveBeenCalledOnce();
    expect((await stream.result()).stopReason).toBe("stop");
  });
  it("context policy rejection terminates without reserving or spending", async () => {
    const beforeCall = vi.fn((_call: { inputTokensEstimate: number }) => "reservation");
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      { beforeCall, afterCall: vi.fn() },
      undefined,
      {
        prepareContext: () => {
          throw new Error("context exceeds budget");
        },
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("context exceeds budget");
    expect(beforeCall).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
  it("does not count an already-aborted next turn as a model call", async () => {
    const beforeCall = vi.fn();
    const afterCall = vi.fn();
    const prepareContext = vi.fn();
    const recordUsage = vi.fn();
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { signal: AbortSignal.abort(new Error("synthetic tool stop")), fetch: fetcher },
      push,
      { beforeCall, afterCall },
      undefined,
      { prepareContext, recordUsage },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("synthetic tool stop");
    for (const callback of [beforeCall, afterCall, prepareContext, recordUsage, fetcher, push])
      expect(callback).not.toHaveBeenCalled();
  });
  it("retains reported zero through the full generic runtime and its safe network adapter", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
    try {
      const events: AgentRuntimeEvent[] = [];
      for await (const event of new PiAgentRuntime().run(
        {
          botId: "bot-fixture",
          threadId: "thread-fixture",
          runId: "run-fixture",
          prompt: "test",
          instructions: "fixture",
          history: [],
          tools: [],
          model: {
            provider: "openai-compatible",
            id: "fixture",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          },
        },
        { signal: AbortSignal.timeout(5000) },
      ))
        events.push(event);
      expect(events.find((event) => event.type === "usage")).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("keeps network protections when composing raw-usage observation", async () => {
    const fetcher = vi.fn();
    const safe = createOpenAiCompatibleFetch(usageReportingFetch(fetcher, new Set()));
    await expect(safe("http://169.254.169.254/v1/chat/completions")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves real endpoint cache and reasoning breakdown without double counting", async () => {
    const { events, afterCall, result } = await run({
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "usage",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: null,
      reasoningTokens: 10,
      totalTokens: 130,
      costSource: "pi-catalog-estimate",
    });
    expect(afterCall).toHaveBeenCalledOnce();
  });
  it("distinguishes explicit reported zero from omitted provider measurements", async () => {
    const reported = await run({
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(reported.events[0]).toMatchObject({
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
    });
    const omitted = await run();
    expect(omitted.events[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
  it.each(["prompt_cache_hit_tokens", "cached_tokens"])(
    "recognizes cache-read alias %s with fully cached input",
    async (alias) => {
      const { events } = await run({
        prompt_tokens: 40,
        completion_tokens: 2,
        total_tokens: 42,
        [alias]: 40,
      });
      expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
    },
  );
  it("recognizes all-cache-write input and explicit zero read usage", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 40 });
  });
  it("preserves zero uncached input when all reported prompt tokens are cached", async () => {
    const { events } = await run({
      prompt_tokens: 40,
      completion_tokens: 2,
      total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(events[0]).toMatchObject({ inputTokens: 0, cacheReadTokens: 40 });
  });
  it("preserves provider reported dollar cost even when pricing or cache-write usage is unavailable", async () => {
    const { events } = await run({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      cost: 0.00003,
    });
    expect(events[0]).toMatchObject({
      costUsd: 0.00003,
      costSource: "provider-reported",
      pricingVersion: null,
      cacheWriteTokens: null,
    });
  });
  it("keeps compatible zero pricing unknown", () => {
    expect(
      normalizePiUsage(
        {
          input: 10,
          output: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ).costUsd,
    ).toBeNull();
  });
  it("does not start model work when budget reservation fails", async () => {
    const fetcher = vi.fn();
    const push = vi.fn();
    const stream = await observedPiStream(
      builtinModels(),
      model,
      { messages: [] },
      { fetch: fetcher },
      push,
      {
        beforeCall: () => {
          throw new Error("budget exhausted");
        },
        afterCall: vi.fn(),
      },
    );
    for await (const _event of stream) {
    }
    expect((await stream.result()).errorMessage).toBe("budget exhausted");
    expect(push).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains bytes and observes fragmented CRLF SSE with explicit zeros", async () => {
    const bytes = new TextEncoder().encode('data: {"usage":{"prompt_tokens":0}}\r\n\r\n');
    const reported = new Set<"inputTokens">();
    const fetcher = usageReportingFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      reported,
    );
    const response = await fetcher("https://model.example.test");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(reported.has("inputTokens")).toBe(true);
  });
});
