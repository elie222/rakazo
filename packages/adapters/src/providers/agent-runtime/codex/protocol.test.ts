import { describe, expect, it, vi } from "vitest";
import type { CodexProtocolChannel } from "./protocol.js";
import { runCodexTextProtocol } from "./protocol.js";

const input = { runId: "run", model: "configured", instructions: "", prompt: "Hello" };
const frame = (method: string, params: Record<string, unknown> = {}) => ({
  method,
  params: { threadId: "thread", turnId: "turn", ...params },
});
const done = frame("turn/completed", { turn: { id: "turn", status: "completed" } });
function fixture(frames: unknown[] = [done]) {
  const channel: CodexProtocolChannel = {
    request: vi.fn(async (method) => {
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") return { turn: { id: "turn" } };
      return {};
    }),
    send: vi.fn(async () => {}),
    async *messages() {
      yield* frames;
    },
    close: vi.fn(async () => {}),
  };
  const controller = new AbortController();
  const events = async () => {
    const result = [];
    for await (const event of runCodexTextProtocol(channel, input, controller.signal))
      result.push(event);
    return result;
  };
  return { channel, controller, events };
}

describe("unregistered text-only app-server protocol", () => {
  it("negotiates an ephemeral tool-free request and maps text with one cumulative usage record", async () => {
    const usage = frame("thread/tokenUsage/updated", {
      tokenUsage: {
        total: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 2,
          totalTokens: 12,
        },
      },
    });
    const f = fixture([frame("item/agentMessage/delta", { delta: "Hello" }), usage, usage, done]);
    expect(await f.events()).toEqual([
      { type: "text", text: "Hello" },
      expect.objectContaining({
        type: "usage",
        inputTokens: 7,
        cacheReadTokens: 3,
        outputTokens: 2,
      }),
      { type: "done", text: "Hello" },
    ]);
    expect(f.channel.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        environments: [],
        dynamicTools: [],
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "on-request",
      }),
      f.controller.signal,
    );
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it("preserves a final-only answer and reports unknown usage honestly", async () => {
    const f = fixture([
      frame("item/completed", { item: { type: "agentMessage", text: "Hi" } }),
      done,
    ]);
    expect(await f.events()).toEqual([
      { type: "text", text: "Hi" },
      expect.objectContaining({ type: "usage", inputTokens: null, outputTokens: null }),
      { type: "done", text: "Hi" },
    ]);
  });
  it("denies native approval requests without forwarding untrusted error text", async () => {
    const f = fixture([{ ...frame("item/commandExecution/requestApproval"), id: 42 }]);
    await expect(f.events()).rejects.toThrow("unsupported operation");
    expect(f.channel.send).toHaveBeenLastCalledWith(
      { id: 42, error: { code: -32601, message: "Request denied." } },
      f.controller.signal,
    );
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it.each(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "newFutureTool"])(
    "refuses %s lifecycle items, not only approval requests",
    async (type) => {
      const f = fixture([frame("item/started", { item: { type } }), done]);
      await expect(f.events()).rejects.toThrow("unsupported item");
      expect(f.channel.close).toHaveBeenCalledOnce();
    },
  );
  it("refuses cross-run output", async () => {
    const f = fixture([frame("item/agentMessage/delta", { threadId: "other", delta: "private" })]);
    await expect(f.events()).rejects.toThrow("identity mismatch");
  });
  it("requires a successful explicit terminal, not EOF", async () => {
    await expect(fixture([]).events()).rejects.toThrow("explicit terminal");
    await expect(
      fixture([frame("turn/completed", { turn: { id: "turn", status: "failed" } })]).events(),
    ).rejects.toThrow("did not complete");
  });
  it("closes even when setup fails", async () => {
    const f = fixture();
    vi.mocked(f.channel.request).mockRejectedValue(new Error("transport failed"));
    await expect(f.events()).rejects.toThrow("transport failed");
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it("does not initialize a pre-cancelled turn", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.events()).rejects.toThrow();
    expect(f.channel.request).not.toHaveBeenCalled();
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it("closes when the consumer stops reading", async () => {
    const f = fixture([frame("item/agentMessage/delta", { delta: "first" }), done]);
    const iterator = runCodexTextProtocol(f.channel, input, f.controller.signal);
    await iterator.next();
    await iterator.return(undefined);
    expect(f.channel.close).toHaveBeenCalledOnce();
  });
  it("refuses malformed accounting and unknown protocol notifications", async () => {
    await expect(
      fixture([
        frame("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: -1 } } }),
      ]).events(),
    ).rejects.toThrow("usage");
    await expect(fixture([frame("future/action")]).events()).rejects.toThrow("Unsupported");
  });
});
