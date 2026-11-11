import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { describe, expect, it } from "vitest";
import { splitLeadingThinkBlock } from "./pi-think-tags.js";

const base = {
  role: "assistant",
  api: "openai-completions",
  provider: "local",
  model: "example-model",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
} as unknown as AssistantMessage;

/** A response the way a chat-completions server streams it: one text block, then tool calls. */
function upstream(chunks: string[], toolCalls: ToolCall[] = [], end: "done" | "error" = "done") {
  const stream = createAssistantMessageEventStream();
  const text: TextContent = { type: "text", text: "" };
  const content: AssistantMessage["content"] = [];
  const partial = () => ({ ...base, content: content.map((block) => ({ ...block })) });
  stream.push({ type: "start", partial: partial() });
  if (chunks.length) {
    content.push(text);
    stream.push({ type: "text_start", contentIndex: 0, partial: partial() });
    for (const delta of chunks) {
      text.text += delta;
      content[0] = { ...text };
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial: partial() });
    }
    if (end === "done") {
      stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: partial() });
    }
  }
  for (const toolCall of toolCalls) {
    content.push(toolCall);
    const contentIndex = content.length - 1;
    stream.push({ type: "toolcall_start", contentIndex, partial: partial() });
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: partial() });
  }
  if (end === "done") stream.push({ type: "done", reason: "stop", message: partial() });
  else stream.push({ type: "error", reason: "error", error: partial() });
  stream.end();
  return stream;
}

async function collect(chunks: string[], toolCalls?: ToolCall[], end?: "done" | "error") {
  const stream = splitLeadingThinkBlock(upstream(chunks, toolCalls, end));
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

const deltas = (events: AssistantMessageEvent[], type: "text_delta" | "thinking_delta") =>
  events.flatMap((event) => (event.type === type ? [event.delta] : [])).join("");
const types = (events: AssistantMessageEvent[]) => events.map((event) => event.type);
const lookup: ToolCall = { type: "toolCall", id: "call-1", name: "lookup", arguments: {} };

describe("leading think block", () => {
  it("reports the thoughts as thinking and the rest as the answer", async () => {
    const { events, result } = await collect([
      "<think>\nplan the ",
      "reply\n</think>\n\nHel",
      "lo",
    ]);
    expect(deltas(events, "thinking_delta")).toBe("plan the reply\n");
    expect(deltas(events, "text_delta")).toBe("Hello");
    expect(types(events)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const answer = [
      { type: "thinking", thinking: "plan the reply\n" },
      { type: "text", text: "Hello" },
    ];
    expect(result.content).toEqual(answer);
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: answer } });
  });

  it("recognises tags that arrive split across chunks", async () => {
    const { events, result } = await collect(["<th", "ink>a</th", "ink>", "b"]);
    expect(deltas(events, "thinking_delta")).toBe("a");
    expect(deltas(events, "text_delta")).toBe("b");
    expect(result.content).toEqual([
      { type: "thinking", thinking: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("never shows thoughts or a tag as answer text while they stream", async () => {
    const { events } = await collect(["<think>step one </thi", "nking is not a tag</think>Done"]);
    for (const event of events) {
      if (event.type === "done") continue;
      const shown = "partial" in event ? event.partial.content : [];
      for (const block of shown) {
        if (block.type === "text") expect("Done".startsWith(block.text)).toBe(true);
      }
    }
    expect(deltas(events, "thinking_delta")).toBe("step one </thinking is not a tag");
    expect(deltas(events, "text_delta")).toBe("Done");
  });

  it("keeps a tool call after the thoughts at the place the message gives it", async () => {
    const silent = await collect(["<think>look it up</think>"], [lookup]);
    expect(silent.result.content).toEqual([{ type: "thinking", thinking: "look it up" }, lookup]);
    expect(silent.events).toContainEqual(
      expect.objectContaining({ type: "toolcall_end", contentIndex: 1 }),
    );
    const spoken = await collect(["<think>look it up</think>One moment."], [lookup]);
    expect(spoken.result.content).toEqual([
      { type: "thinking", thinking: "look it up" },
      { type: "text", text: "One moment." },
      lookup,
    ]);
    expect(spoken.events).toContainEqual(
      expect.objectContaining({ type: "toolcall_end", contentIndex: 2 }),
    );
  });

  it("keeps thoughts out of the answer when the response ends inside them", async () => {
    const { events, result } = await collect(["<think>still working"], [], "error");
    expect(result.content).toEqual([{ type: "thinking", thinking: "still working" }]);
    expect(deltas(events, "text_delta")).toBe("");
  });
});

describe("text without a leading think block", () => {
  it.each([
    [["Hello ", "there"]],
    [["<", "b>bold</b>"]],
    [["<thin", "g>"]],
    [["The <think> tag is not at the start</think>"]],
    [["<"]],
  ])("passes %j through as the answer", async (chunks) => {
    const { events, result } = await collect(chunks);
    const text = chunks.join("");
    expect(deltas(events, "text_delta")).toBe(text);
    expect(types(events).filter((type) => type.startsWith("thinking"))).toEqual([]);
    expect(types(events).filter((type) => type === "text_start")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text_end", contentIndex: 0, content: text }),
    );
    expect(result.content).toEqual([{ type: "text", text }]);
  });
});
