import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAsk } from "@rakazo/adapter-kit";
import type { ToolQuestion, ToolQuestionAnswer } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpCallClock,
  McpElicitationRouter,
  toolQuestionFromElicitation,
} from "./mcp-elicitation.js";
import { callRemoteMcpTool, RemoteMcpSessionCache } from "./remote-mcp.js";

const ENDPOINT = "https://gateway.example.test/mcp";
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

const APPROVAL: ElicitRequest["params"] = {
  message: "Allow send_email to run?",
  requestedSchema: {
    type: "object",
    properties: { approve: { type: "boolean", title: "Approve" } },
    required: ["approve"],
  },
};

/**
 * A gateway on the official SDK whose `guarded` tool stops to ask the client `params` and
 * answers with what came back, or with the error the ask failed with.
 */
function gateway(params: ElicitRequest["params"] = APPROVAL) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = new McpServer({ name: "gateway", version: "1" });
  const capabilities: unknown[] = [];
  server.registerTool("guarded", { description: "Needs approval" }, async (extra) => {
    capabilities.push(server.server.getClientCapabilities()?.elicitation);
    try {
      const answer = await extra.sendRequest(
        { method: "elicitation/create", params },
        ElicitResultSchema,
        // Like Executor, the gateway waits as long as the person takes.
        { timeout: 60 * 60_000 },
      );
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `error: ${(error as Error).message}` }] };
    }
  });
  const connected = server.connect(transport);
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    await connected;
    return transport.handleRequest(new Request(input, init));
  });
  return { fetch, capabilities, close: () => server.close() };
}

function call(
  server: ReturnType<typeof gateway>,
  ask: ToolAsk | undefined,
  pool?: RemoteMcpSessionCache,
) {
  return callRemoteMcpTool(
    {
      endpoint: ENDPOINT,
      fetch: server.fetch as typeof globalThis.fetch,
      resolveHostname: publicResolver,
      longToolCalls: true,
      elicitation: true,
      asker: { owner: "run-1", source: "Gateway", ask },
      ...(pool ? { sessionPool: pool, sessionScope: "run-1", sessionRunId: "run-1" } : {}),
    },
    "guarded",
    {},
  ) as Promise<{ content: Array<{ text: string }> }>;
}

const answerOf = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe("MCP elicitation", () => {
  const servers: Array<ReturnType<typeof gateway>> = [];
  const open = (params?: ElicitRequest["params"]) => {
    const server = gateway(params);
    servers.push(server);
    return server;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("tells the server it may ask, in form mode only", async () => {
    const server = open();
    await call(server, async () => ({ action: "decline" }));
    expect(server.capabilities).toEqual([{ form: {} }]);
  });

  it("shows the person the form and sends the server their answer", async () => {
    const server = open();
    const asked: ToolQuestion[] = [];
    const result = await call(server, async (question) => {
      asked.push(question);
      return { action: "accept", values: { approve: true } };
    });
    expect(asked).toEqual([
      {
        source: "Gateway",
        message: "Allow send_email to run?",
        fields: [{ name: "approve", label: "Approve", required: true, type: "boolean" }],
      },
    ]);
    expect(JSON.parse(answerOf(result))).toEqual({
      action: "accept",
      content: { approve: true },
    });
  });

  it("sends a decline", async () => {
    const server = open();
    const result = await call(server, async () => ({ action: "decline" }));
    expect(JSON.parse(answerOf(result))).toEqual({ action: "decline" });
  });

  it("declines at once when the run has nobody to ask", async () => {
    const server = open();
    const result = await call(server, undefined);
    expect(JSON.parse(answerOf(result))).toEqual({ action: "decline" });
  });

  it("answers cancel when the person never answers", async () => {
    const server = open();
    // The run's wait ran out (or its process is stopping): the ask ends without an answer.
    const result = await call(server, async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(JSON.parse(answerOf(result))).toEqual({ action: "cancel" });
  });

  it("declines a form with nested fields without showing it", async () => {
    const server = open({
      message: "Where to?",
      requestedSchema: {
        type: "object",
        properties: { to: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
      },
    });
    const ask = vi.fn<ToolAsk>();
    const result = await call(server, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.parse(answerOf(result))).toEqual({ action: "decline" });
  });

  it("refuses a URL-mode request as the spec requires, showing and opening nothing", async () => {
    const server = open({
      mode: "url",
      message: "Sign in",
      elicitationId: "e1",
      url: "https://gateway.example.test/approve",
    });
    const ask = vi.fn<ToolAsk>();
    const result = await call(server, ask);
    expect(ask).not.toHaveBeenCalled();
    expect(answerOf(result)).toMatch(/^error: .*URL-mode/);
    expect(server.fetch.mock.calls.map(([url]) => String(url))).toEqual(
      expect.not.arrayContaining(["https://gateway.example.test/approve"]),
    );
  });

  it("keeps one question open at a time, declining another while it waits", async () => {
    const router = new McpElicitationRouter();
    const handlers: Array<(request: unknown, extra: { signal: AbortSignal }) => Promise<unknown>> =
      [];
    router.install({
      setRequestHandler: (_schema: unknown, handler: (typeof handlers)[number]) =>
        handlers.push(handler),
    } as never);
    const answered = deferred<void>();
    const ask = vi.fn<ToolAsk>(async () => {
      await answered.promise;
      return { action: "decline" };
    });
    const untrack = router.track({ owner: "run-1", source: "Gateway", ask });
    const request = { params: APPROVAL };
    const extra = { signal: new AbortController().signal };
    const first = handlers[0]!(request, extra);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(await handlers[0]!(request, extra)).toEqual({ action: "decline" });
    expect(ask).toHaveBeenCalledOnce();
    answered.resolve();
    await first;
    untrack();
  });

  it("closes the question when its call ends", async () => {
    const router = new McpElicitationRouter();
    let handler:
      | ((request: unknown, extra: { signal: AbortSignal }) => Promise<unknown>)
      | undefined;
    router.install({
      setRequestHandler: (_: unknown, h: typeof handler) => (handler = h),
    } as never);
    const call = new AbortController();
    const sibling = new AbortController();
    router.track({ owner: "run-1", source: "Gateway", signal: sibling.signal });
    const seen = deferred<AbortSignal>();
    router.track({
      owner: "run-1",
      source: "Gateway",
      signal: call.signal,
      ask: (_question, signal) => {
        seen.resolve(signal);
        const ended = deferred<ToolQuestionAnswer>();
        signal.addEventListener("abort", () => ended.reject(signal.reason));
        return ended.promise;
      },
    });
    const answered = handler!({ params: APPROVAL }, { signal: new AbortController().signal });
    const signal = await seen.promise;
    // Another call of the same run ending leaves the question open; the last one closes it.
    sibling.abort();
    expect(signal.aborted).toBe(false);
    call.abort();
    expect(signal.aborted).toBe(true);
    expect(await answered).toEqual({ action: "cancel" });
  });

  it("closes an open question when its call returns", async () => {
    const asked = deferred<AbortSignal>();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    const server = new McpServer({ name: "gateway", version: "1" });
    // The server asks, then answers the call without waiting for the person.
    server.registerTool("guarded", { description: "Asks and moves on" }, async (extra) => {
      void extra
        .sendRequest({ method: "elicitation/create", params: APPROVAL }, ElicitResultSchema, {
          timeout: 60 * 60_000,
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(asked).toBeDefined());
      await asked.promise;
      return { content: [{ type: "text", text: "done" }] };
    });
    const connected = server.connect(transport);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await connected;
      return transport.handleRequest(new Request(input, init));
    });
    const gatewayServer = { fetch, capabilities: [], close: () => server.close() };
    servers.push(gatewayServer);
    const result = await call(gatewayServer, (_question, signal) => {
      asked.resolve(signal);
      return new Promise(() => undefined);
    });
    expect(answerOf(result)).toBe("done");
    expect((await asked.promise).aborted).toBe(true);
  });

  it("asks through a run's reused session too", async () => {
    const server = open();
    const pool = new RemoteMcpSessionCache(0);
    try {
      for (const action of ["decline", "accept"] as const) {
        const result = await call(
          server,
          async () =>
            action === "accept" ? { action, values: { approve: false } } : { action: "decline" },
          pool,
        );
        expect(JSON.parse(answerOf(result)).action).toBe(action);
      }
    } finally {
      await pool.close();
    }
  });

  it("does not count the time the person spends answering against the call", async () => {
    // Real time still passes, so the HTTP exchange runs; the clocks also jump on demand.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = open();
    const asked = deferred<void>();
    const answered = deferred<void>();
    const pending = call(server, async () => {
      asked.resolve();
      await answered.promise;
      return { action: "accept", values: { approve: true } };
    });
    await asked.promise;
    // Longer than the call's idle wait and its total: both are paused while the card is open.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    answered.resolve();
    expect(JSON.parse(answerOf(await pending)).action).toBe("accept");
  });
});

describe("McpCallClock", () => {
  afterEach(() => vi.useRealTimers());

  it("times out without progress, restarts on progress, and pauses while asking", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const clock = new McpCallClock(1_000, 5_000, fired);
    vi.advanceTimersByTime(900);
    clock.progress();
    vi.advanceTimersByTime(900);
    expect(fired).not.toHaveBeenCalled();
    const resume = clock.pause();
    vi.advanceTimersByTime(60_000);
    expect(fired).not.toHaveBeenCalled();
    resume();
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
  });

  it("ends at its wall-clock ceiling even while a question is open", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const clock = new McpCallClock(1_000, 2_000, fired, 10_000);
    clock.pause();
    vi.advanceTimersByTime(9_999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
  });

  it("keeps the total budget across pauses", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const clock = new McpCallClock(1_000, 2_500, fired);
    for (let step = 0; step < 2; step += 1) {
      vi.advanceTimersByTime(800);
      clock.progress();
      clock.pause()();
    }
    vi.advanceTimersByTime(899);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
    clock.end();
  });
});

describe("toolQuestionFromElicitation", () => {
  it("reads flat text, number, yes/no and choice fields, capping the server's text", () => {
    const question = toolQuestionFromElicitation("Gateway", {
      message: `Line one\u0007\n${"x".repeat(2_000)}`,
      requestedSchema: {
        properties: {
          note: { type: "string", maxLength: 10_000, format: "email" },
          count: { type: "integer", minimum: 1, title: "How many" },
          size: { type: "string", oneOf: [{ const: "s", title: "Small" }] },
          plan: { type: "string", enum: ["a", "b"], enumNames: ["Plan A"] },
        },
        required: ["count"],
      },
    });
    expect(question?.message.startsWith("Line one\n")).toBe(true);
    expect(question?.message).toHaveLength(1_000);
    expect(question?.fields).toEqual([
      {
        name: "note",
        label: "note",
        required: false,
        type: "text",
        format: "email",
        maxLength: 2_000,
      },
      {
        name: "count",
        label: "How many",
        required: true,
        type: "number",
        integer: true,
        minimum: 1,
      },
      {
        name: "size",
        label: "size",
        required: false,
        type: "choice",
        options: [{ value: "s", label: "Small" }],
      },
      {
        name: "plan",
        label: "plan",
        required: false,
        type: "choice",
        options: [
          { value: "a", label: "Plan A" },
          { value: "b", label: "b" },
        ],
      },
    ]);
  });

  it("skips a text field whose shortest answer is longer than this client takes", () => {
    expect(
      toolQuestionFromElicitation("G", {
        message: "m",
        requestedSchema: { properties: { essay: { type: "string", minLength: 5_000 } } },
      }),
    ).toBeUndefined();
  });

  it("skips a form that requires a field it does not define", () => {
    expect(
      toolQuestionFromElicitation("G", {
        message: "m",
        requestedSchema: { properties: {}, required: ["approve"] },
      }),
    ).toBeUndefined();
  });

  it("drops a default its own field would refuse", () => {
    const question = toolQuestionFromElicitation("G", {
      message: "m",
      requestedSchema: {
        properties: {
          count: { type: "integer", minimum: 1, maximum: 5, default: 9 },
          ratio: { type: "number", default: 0.5 },
          code: { type: "string", maxLength: 3, default: "toolong" },
        },
      },
    });
    expect(question?.fields.map((field) => "default" in field)).toEqual([false, true, false]);
  });

  it("skips a number range nothing fits", () => {
    expect(
      toolQuestionFromElicitation("G", {
        message: "m",
        requestedSchema: { properties: { n: { type: "number", minimum: 10, maximum: 5 } } },
      }),
    ).toBeUndefined();
    expect(
      toolQuestionFromElicitation("G", {
        message: "m",
        requestedSchema: { properties: { n: { type: "integer", minimum: 0.5, maximum: 0.6 } } },
      }),
    ).toBeUndefined();
  });

  it("skips URL mode, nested objects and multi-select", () => {
    expect(toolQuestionFromElicitation("G", { mode: "url", message: "Go" })).toBeUndefined();
    for (const property of [
      { type: "object", properties: {} },
      { type: "array", items: { type: "string", enum: ["a"] } },
    ])
      expect(
        toolQuestionFromElicitation("G", {
          message: "m",
          requestedSchema: { properties: { field: property } },
        }),
      ).toBeUndefined();
  });
});
