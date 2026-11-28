import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createKimiCodeRuntime } from "./runtime.js";

const request: AgentRunRequest = {
  botId: "b",
  threadId: "t",
  runId: "r",
  sourceMessageId: "msg",
  prompt: "hello",
  instructions: "",
  history: [],
  tools: [],
  model: { provider: "test", id: "text-model", apiKey: "fake-key", connectionId: "c" },
};

const encode = (frame: object) => JSON.stringify({ jsonrpc: "2.0", ...frame });
const terminal = encode({ id: 3, result: { stopReason: "end_turn" } });
const message = (text: string) =>
  encode({
    method: "session/update",
    params: {
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });

const goodReceipt = { runId: "r", connectionId: "c", modelId: "text-model" };

function fake(tail: string[], admitted = true, receipt: typeof goodReceipt | null = goodReceipt) {
  const close = vi.fn();
  const send = vi.fn(async (_frame: object) => {});
  const consumeVerifiedProviderCompletion = vi.fn(() => receipt ?? undefined);
  const open = vi.fn((_input: object) => ({
    cwd: "/isolated",
    async *lines() {
      yield encode({ id: 1, result: { protocolVersion: 1 } });
      yield encode({ id: 2, result: { sessionId: "s" } });
      yield* tail;
    },
    send,
    close,
    consumeVerifiedProviderCompletion,
  }));
  // Expose an iterable, not the iterator factory API of this fixture.
  const runtime = createKimiCodeRuntime({
    admitsInteractiveOwnerTurn: () => admitted,
    open: (input) => {
      const child = open(input);
      return { ...child, lines: child.lines() };
    },
  });
  return { runtime, close, send, open, consumeVerifiedProviderCompletion };
}

async function collect(runtime: AgentRuntime, input = request) {
  const events = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}

describe("dormant Kimi Code runtime", () => {
  it("publishes only a completed text turn and discards the child", async () => {
    const f = fake([message("answer"), terminal]);
    await expect(collect(f.runtime)).resolves.toEqual([
      { type: "text", text: "answer" },
      { type: "done", text: "answer" },
    ]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledExactlyOnceWith({
      ...goodReceipt,
      apiKey: "fake-key",
      signal: expect.any(AbortSignal),
    });
    expect(f.consumeVerifiedProviderCompletion).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls.map(([frame]) => frame)).not.toContainEqual(
      expect.objectContaining({ apiKey: "fake-key" }),
    );
  });

  it.each([
    ["missing", null],
    ["other run", { ...goodReceipt, runId: "different-run" }],
    ["other connection", { ...goodReceipt, connectionId: "different-connection" }],
    ["other model", { ...goodReceipt, modelId: "different-model" }],
  ] as const)("withholds partial answer when the receipt is %s", async (_, receipt) => {
    const f = fake([message("partial"), terminal], true, receipt);
    const turn = f.runtime.run(request)[Symbol.asyncIterator]();
    await expect(turn.next()).rejects.toThrow(/^Kimi Code ACP turn did not complete\.$/);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("does not publish text or query the receipt on a rejected ACP prompt", async () => {
    const f = fake([
      message("partial"),
      encode({ id: 3, error: { code: -32000, message: "fixture private diagnostics" } }),
    ]);
    await expect(collect(f.runtime)).rejects.toThrow(/^Kimi Code ACP turn did not complete\.$/);
    expect(f.consumeVerifiedProviderCompletion).not.toHaveBeenCalled();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("never opens a child without positive interactive owner admission", async () => {
    const f = fake([], false);
    await expect(collect(f.runtime)).rejects.toThrow("eligible personal");
    expect(f.open).not.toHaveBeenCalled();
  });

  it("does not publish partial text if the child then requests permissions", async () => {
    const f = fake([
      message("partial"),
      encode({ id: 8, method: "session/request_permission" }),
      terminal,
    ]);
    const turn = f.runtime.run(request)[Symbol.asyncIterator]();
    await expect(turn.next()).rejects.toThrow("did not complete");
    expect(f.send).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      id: 8,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("aborts its child without publishing buffered text", async () => {
    const close = vi.fn();
    let runtime: AgentRuntime;
    runtime = createKimiCodeRuntime({
      admitsInteractiveOwnerTurn: () => true,
      open: ({ signal }) => ({
        cwd: "/isolated",
        lines: (async function* () {
          yield encode({ id: 1, result: { protocolVersion: 1 } });
          yield encode({ id: 2, result: { sessionId: "s" } });
          yield message("partial");
          await runtime.abort(request.runId);
          expect(signal.aborted).toBe(true);
          yield terminal;
        })(),
        send: async () => {},
        close,
        consumeVerifiedProviderCompletion: () => goodReceipt,
      }),
    });
    await expect(collect(runtime)).rejects.toThrow("did not complete");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not return echoed credentials", async () => {
    const f = fake([message("prefix fake-"), message("key suffix"), terminal]);
    await expect(collect(f.runtime)).rejects.toThrow("did not complete");
  });
});
