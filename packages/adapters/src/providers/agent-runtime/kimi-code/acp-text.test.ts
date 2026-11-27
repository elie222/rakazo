import { describe, expect, it } from "vitest";
import { createTextTurn } from "./acp-text.js";

const encode = (frame: object) => JSON.stringify({ jsonrpc: "2.0", ...frame });

function promptTurn() {
  const turn = createTextTurn({ cwd: "/isolated", prompt: "hello" });
  expect(turn.initialize.params.clientCapabilities).toEqual({});
  expect(turn.receive(encode({ id: 1, result: { protocolVersion: 1 } })).send).toMatchObject({
    method: "session/new",
    params: { cwd: "/isolated", mcpServers: [] },
  });
  expect(turn.receive(encode({ id: 2, result: { sessionId: "a" } })).send).toMatchObject({
    method: "session/prompt",
    params: { sessionId: "a", prompt: [{ type: "text", text: "hello" }] },
  });
  return turn;
}

function chunk(sessionId: string) {
  return encode({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    },
  });
}

describe("Kimi Code ACP single text turn", () => {
  it("accepts same-session text followed by a successful terminal message", () => {
    const turn = promptTurn();
    expect(turn.receive(chunk("a"))).toEqual({ text: "hi" });
    expect(turn.receive(encode({ id: 3, result: { stopReason: "end_turn" } }))).toEqual({
      done: true,
    });
  });

  it("cancels a reverse approval and never treats subsequent text as success", () => {
    const turn = promptTurn();
    expect(
      turn.receive(encode({ id: 8, method: "session/request_permission", params: {} })),
    ).toEqual({
      denied: true,
      send: { jsonrpc: "2.0", id: 8, result: { outcome: { outcome: "cancelled" } } },
    });
    expect(() => turn.receive(chunk("a"))).toThrow("ACP turn rejected");
  });

  it("never serves reverse filesystem RPC", () => {
    const turn = promptTurn();
    expect(
      turn.receive(encode({ id: 8, method: "fs/read_text_file", params: {} })).send,
    ).toMatchObject({
      id: 8,
      error: { code: -32601 },
    });
  });

  it("rejects an unrelated native session, even after valid assistant text", () => {
    const turn = promptTurn();
    expect(turn.receive(chunk("a"))).toEqual({ text: "hi" });
    expect(() => turn.receive(chunk("other"))).toThrow("ACP turn rejected");
    expect(() => turn.receive(encode({ id: 3, result: { stopReason: "end_turn" } }))).toThrow(
      "ACP turn rejected",
    );
  });
});
