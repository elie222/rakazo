import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isMissingFinishReasonError, PiAgentRuntime } from "./pi-runtime.js";

const gatewayCalls = new Map<string, number>();

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state: { errorMessage?: string; messages: unknown[] } = { messages: [] };
    readonly scenario: string;
    private subscriber?: (event: Record<string, unknown>) => void;
    private releasePrompt?: () => void;

    constructor(input: { initialState: { model: { id: string } } }) {
      this.scenario = input.initialState.model.id;
    }

    subscribe(subscriber: (event: Record<string, unknown>) => void) {
      this.subscriber = subscriber;
    }

    async prompt() {
      const assistant = (text: string) => ({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      const textDelta = (delta: string) =>
        this.subscriber?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta },
        });

      if (this.scenario === "normal") {
        textDelta("Normal reply");
        this.state.messages = [assistant("Normal reply")];
        this.subscriber?.({ type: "message_end", message: assistant("Normal reply") });
        return;
      }
      if (this.scenario === "state-only") {
        this.state.errorMessage = "Stream ended without finish_reason";
        this.state.messages = [assistant("Reply retained in agent state")];
        return;
      }
      if (this.scenario === "partial-missing") {
        textDelta("Partial reply");
        this.state.messages = [assistant("Partial reply")];
        throw new Error("Stream ended without finish_reason");
      }
      if (this.scenario === "partial-failure") {
        textDelta("Unfinished reply");
        this.state.errorMessage = "upstream disconnected";
        this.state.messages = [assistant("Unfinished reply")];
        return;
      }
      if (this.scenario === "tool-only") {
        this.subscriber?.({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "read_file",
          args: { path: "fixture.txt" },
        });
        this.subscriber?.({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "read_file",
          isError: false,
        });
        this.state.errorMessage = "Stream ended without finish_reason";
        this.state.messages = [{ role: "toolResult", content: [] }];
        return;
      }
      if (this.scenario === "abort") {
        await new Promise<void>((resolve) => {
          this.releasePrompt = resolve;
        });
        return;
      }
      this.state.errorMessage = "Stream ended without finish_reason";
    }

    async waitForIdle() {}
    abort() {
      this.state.errorMessage = "aborted";
      this.releasePrompt?.();
    }
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (provider: string, modelId: string) =>
      provider === "gateway:test" ? { provider, id: modelId } : undefined,
    setProvider() {},
    streamSimple: () => {
      throw new Error("the mocked agent owns the deterministic stream");
    },
  }),
}));

let gateway: Server;
let gatewayBaseUrl = "";

beforeAll(async () => {
  gateway = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
    gatewayCalls.set(model, (gatewayCalls.get(model) ?? 0) + 1);

    if (model === "empty-recovery") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "Recovered once" } }] }));
      return;
    }
    if (model === "malformed-recovery") {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        'data: {"choices":[{"delta":{"content":"Recovered "}}]}\n\ndata: malformed\n\ndata: {"choices":[{"delta":{"content":"partially"}}]}\n\n',
      );
      return;
    }
    if (model === "failed-recovery") {
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { message: "fake upstream failed" } }));
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address() as AddressInfo;
  gatewayBaseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    gateway.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => gatewayCalls.clear());

describe("gateway stream termination", () => {
  it("recognizes only the Pi missing-finish marker", () => {
    expect(isMissingFinishReasonError("Stream ended without finish_reason")).toBe(true);
    expect(isMissingFinishReasonError("Provider finish_reason: length")).toBe(false);
  });

  it("completes a normal stream without a recovery request", async () => {
    const events = await runScenario("normal");

    expect(texts(events)).toEqual(["Normal reply"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Normal reply" });
    expect(gatewayCalls.get("normal") ?? 0).toBe(0);
  });

  it("uses assistant state before retrying a missing-finish stream", async () => {
    const events = await runScenario("state-only");

    expect(texts(events)).toEqual(["Reply retained in agent state"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(gatewayCalls.get("state-only") ?? 0).toBe(0);
  });

  it("makes at most one recovery request for a genuinely empty stream", async () => {
    const events = await runScenario("empty-recovery");

    expect(texts(events)).toEqual(["Recovered once"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Recovered once" });
    expect(gatewayCalls.get("empty-recovery")).toBe(1);
  });

  it("fails after one recovery when both gateway replies are empty", async () => {
    const events = await runScenario("empty-failure");

    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "The gateway returned an empty reply",
    });
    expect(gatewayCalls.get("empty-failure")).toBe(1);
  });

  it("keeps valid partial SSE recovery content around malformed events", async () => {
    const events = await runScenario("malformed-recovery");

    expect(texts(events)).toEqual(["Recovered partially"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(gatewayCalls.get("malformed-recovery")).toBe(1);
  });

  it("does not retry after tools have already executed", async () => {
    const events = await runScenario("tool-only");

    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "The model returned no final reply after running tools",
    });
    expect(gatewayCalls.get("tool-only") ?? 0).toBe(0);
  });

  it("accepts partial text when only finish_reason is missing", async () => {
    const events = await runScenario("partial-missing");

    expect(texts(events)).toEqual(["Partial reply"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Partial reply" });
    expect(gatewayCalls.get("partial-missing") ?? 0).toBe(0);
  });

  it("fails a partial stream on a real transport error without completing it", async () => {
    const events = await runScenario("partial-failure");

    expect(texts(events)).toEqual(["Unfinished reply"]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", message: "upstream disconnected" });
  });

  it("surfaces a failing recovery once and does not emit a duplicate completion", async () => {
    const events = await runScenario("failed-recovery");

    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", message: "502: fake upstream failed" });
    expect(gatewayCalls.get("failed-recovery")).toBe(1);
  });

  it("terminates the active request when runtime.abort is called", async () => {
    const runtime = new PiAgentRuntime();
    const contextAbort = new AbortController();
    const iterator = runtime
      .run(requestFor("abort", false), {
        operationId: "stream-abort",
        traceId: "stream-abort",
        workspaceId: "workspace",
        userId: "user",
        signal: contextAbort.signal,
      })
      [Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.done).toBe(false);
    expect(started.value?.type === "progress" || started.value?.type === "reasoning").toBe(true);
    await runtime.abort("run-abort");
    const remaining = await collectWithTimeout(iterator, 1_000).finally(() => contextAbort.abort());

    expect(remaining.at(-1)).toEqual({ type: "error", message: "aborted" });
  });
});

async function runScenario(modelId: string): Promise<AgentRuntimeEvent[]> {
  const runtime = new PiAgentRuntime();
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(requestFor(modelId), {
    operationId: `stream-${modelId}`,
    traceId: `stream-${modelId}`,
    workspaceId: "workspace",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

function requestFor(modelId: string, withGateway = true): AgentRunRequest {
  const model: AgentRunRequest["model"] & { baseUrl?: string } = {
    provider: "gateway:test",
    id: modelId,
    baseUrl: withGateway ? gatewayBaseUrl : undefined,
  };
  return {
    botId: "bot",
    threadId: "thread",
    runId: `run-${modelId}`,
    prompt: "hello",
    instructions: "Be concise.",
    history: [],
    tools: [],
    model,
  };
}

async function collectWithTimeout(
  iterator: AsyncIterator<AgentRuntimeEvent>,
  timeoutMs: number,
): Promise<AgentRuntimeEvent[]> {
  return Promise.race([
    (async () => {
      const events: AgentRuntimeEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) return events;
        events.push(next.value);
      }
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("runtime did not abort")), timeoutMs),
    ),
  ]);
}

function texts(events: AgentRuntimeEvent[]): string[] {
  return events.flatMap((event) => (event.type === "text" ? [event.text] : []));
}

async function readRequestBody(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
