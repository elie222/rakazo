import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  historyReplaysOutsideContent,
  historyToolResults,
  keptTurnTranscript,
} from "../../runs/turn/tool-step-calls.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { toHistory } from "./pi-runtime-history.js";

type Block = { type: string; cache_control?: unknown } & Record<string, unknown>;
type Body = {
  system: Block[];
  tools: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};
type Step = string | Array<{ id: string; file: string }>;

const sse = (events: Array<Record<string, unknown> & { type: string }>) =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );

/** One Messages API reply: text that ends the turn, or tool calls made together. */
function reply(step: Step) {
  const blocks =
    typeof step === "string"
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step } },
          { type: "content_block_stop", index: 0 },
        ]
      : step.flatMap(({ id, file }, index) => [
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name: "save_note", input: {} },
          },
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ file }) },
          },
          { type: "content_block_stop", index },
        ]);
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    ...blocks,
    {
      type: "message_delta",
      delta: { stop_reason: typeof step === "string" ? "end_turn" : "tool_use" },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** The request as cached: every block without the marker that says where to cache. */
const content = (messages: Body["messages"]) =>
  JSON.stringify(messages, (key, value) => (key === "cache_control" ? undefined : value));

const marked = (blocks: Block[]) =>
  blocks.flatMap((block, index) => (block.cache_control ? [index] : []));

/** Runs each turn in one thread, giving the next turn the history the app would store. */
async function conversation(turns: Array<{ ask: string; steps: Step[] }>) {
  const bodies: Body[][] = [];
  const history: AgentRunRequest["history"] = [];
  for (const [turn, { ask, steps }] of turns.entries()) {
    const sent: Body[] = [];
    const runtime = new PiAgentRuntime({
      modelFetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return reply(steps[sent.length - 1]!);
      },
    });
    let transcript: string | undefined;
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: `run-${turn}`,
        sourceMessageId: `ask-${turn}`,
        // Notes that change every turn ride on the prompt, as the app's current time does.
        prompt: `${ask}\n\n<current_time>\nTurn ${turn}\n</current_time>`,
        instructions: "Save notes when asked.",
        history: [...history, { id: `ask-${turn}`, role: "user", content: ask }],
        tools: [
          {
            name: "save_note",
            description: "Save one note.",
            inputSchema: {
              type: "object",
              properties: { file: { type: "string" } },
              required: ["file"],
            },
          },
        ],
        executeTool: async (_name, args) => ({ ok: true, saved: args.file }),
        onTranscript: (value) => {
          transcript = value;
        },
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          apiKey: "fixture-key",
          contextWindow: 200_000,
          maxTokens: 1024,
        },
      } as AgentRunRequest,
      {
        operationId: "transcript-test",
        traceId: "transcript-test",
        spaceId: "space",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // exhaust runtime
    }
    expect(sent).toHaveLength(steps.length);
    bodies.push(sent);
    history.push(
      { id: `ask-${turn}`, role: "user", content: ask },
      {
        id: `reply-${turn}`,
        role: "assistant",
        content: String(steps.at(-1)),
        ...(transcript ? { transcript } : {}),
      },
    );
  }
  return { bodies, history };
}

describe("Pi turn transcript", () => {
  it("starts each turn's request with the last one of the turn before and its reply", async () => {
    const { bodies } = await conversation([
      {
        ask: "Save a, then b.",
        steps: [[{ id: "toolu_a", file: "a" }], [{ id: "toolu_b", file: "b" }], "Saved a and b."],
      },
      {
        ask: "Save c and d together.",
        steps: [
          [
            { id: "toolu_c", file: "c" },
            { id: "toolu_d", file: "d" },
          ],
          "Saved c and d.",
        ],
      },
      { ask: "Thanks.", steps: ["Any time."] },
    ]);
    for (let turn = 1; turn < bodies.length; turn += 1) {
      const last = bodies[turn - 1]!.at(-1)!;
      const next = bodies[turn]![0]!;
      expect(content(next.messages.slice(0, last.messages.length))).toBe(content(last.messages));
      expect(next.messages[last.messages.length]).toMatchObject({ role: "assistant" });
      expect(content(next.messages.slice(last.messages.length, -1))).toContain(
        turn === 1 ? "Saved a and b." : "Saved c and d.",
      );
      expect(JSON.stringify(next.system)).toBe(JSON.stringify(last.system));
      expect(JSON.stringify(next.tools)).toBe(JSON.stringify(last.tools));
      // Anthropic reads the cache back from the new end, at most 20 blocks before it.
      const lastMessage = next.messages.at(-1)!;
      expect(lastMessage.role).toBe("user");
      expect(marked(lastMessage.content as Block[])).toEqual([
        (lastMessage.content as Block[]).length - 1,
      ]);
      expect(marked(next.system)).toEqual([next.system.length - 1]);
      expect(marked(next.tools)).toEqual([next.tools.length - 1]);
      const added = next.messages
        .slice(last.messages.length)
        .reduce(
          (count, message) => count + (Array.isArray(message.content) ? message.content.length : 1),
          0,
        );
      expect(added).toBeLessThanOrEqual(20);
    }
  });

  it("replays a turn from its stored reply when the message it answered is gone", async () => {
    const { history } = await conversation([
      { ask: "Save a.", steps: [[{ id: "toolu_a", file: "a" }], "Saved a."] },
    ]);
    const offered = new Set(["save_note"]);
    const whole = toHistory(history, "", undefined, offered);
    expect(JSON.stringify(whole)).toContain("<current_time>");
    const replayed = toHistory(
      history.filter((message) => message.id !== "ask-0"),
      "",
      undefined,
      offered,
    );
    expect(JSON.stringify(replayed)).not.toContain("<current_time>");
    expect(replayed.at(-1)).toMatchObject({ role: "assistant", content: [{ text: "Saved a." }] });
  });
});

describe("stored turn safety", () => {
  const turn = (tool: string, result: string) =>
    JSON.stringify({
      version: 1,
      represents: ["ask"],
      messages: [
        { role: "user", content: "Check it.", timestamp: 0 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call", name: tool, arguments: { token: "abc" } }],
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: tool,
          content: [{ type: "text", text: result }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stopReason: "stop",
          timestamp: 0,
        },
      ],
    });

  it("keeps no turn that read a secret, and cleans credentials out of the rest", () => {
    expect(keptTurnTranscript(turn("read_secret", "value"), [])).toBeUndefined();
    const bridged = turn("use_tool", "value").replace('{"token":"abc"}', '{"name":"list_secrets"}');
    expect(keptTurnTranscript(bridged, [])).toBeUndefined();
    const kept = keptTurnTranscript(turn("fetch_page", '{"api_key":"sk-live-1"}'), []);
    expect(kept).toBeDefined();
    expect(kept).not.toContain("sk-live-1");
    expect(kept).not.toContain('"abc"');
  });

  it("hands Auto Review and taint the whole results a stored turn replays", () => {
    const history: AgentRunRequest["history"] = [
      {
        id: "reply",
        role: "assistant",
        content: "Done.",
        transcript: turn("fetch_page", "Page text"),
      },
    ];
    expect(historyToolResults(history)).toEqual(["Page text"]);
    expect(historyReplaysOutsideContent(history)).toBe(true);
  });

  it("replays from the reply when a tool the turn called is no longer offered", () => {
    const history: AgentRunRequest["history"] = [
      { id: "ask", role: "user", content: "Check it." },
      {
        id: "reply",
        role: "assistant",
        content: "Done.",
        transcript: turn("fetch_page", "Page text"),
      },
    ];
    expect(JSON.stringify(toHistory(history, "", undefined, new Set(["fetch_page"])))).toContain(
      "Page text",
    );
    expect(JSON.stringify(toHistory(history, "", undefined, new Set(["other"])))).not.toContain(
      "Page text",
    );
  });
});
