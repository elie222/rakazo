import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

type WireMessage = { role: string; content: unknown };

const sse = (events: Array<[string, unknown]>) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const completionsReply = () =>
  new Response(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ok." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

function anthropicReply() {
  return new Response(
    sse([
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "fixture",
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Ok." },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Runs one turn against a recording transport and returns the request body the provider got. */
async function wireBody(
  model: AgentRunRequest["model"],
  reply: () => Response,
  overrides: Partial<AgentRunRequest>,
) {
  let body: { messages: WireMessage[]; system?: unknown } | undefined;
  const runtime = new PiAgentRuntime({
    modelFetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return reply();
    },
  });
  for await (const _event of runtime.run(
    {
      botId: "bot",
      threadId: "thread",
      runId: `run-${Math.random()}`,
      prompt: "What was the token?",
      instructions: "Answer briefly.",
      history: [],
      tools: [],
      model,
      ...overrides,
    },
    {
      operationId: "wire-test",
      traceId: "wire-test",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  )) {
    // exhaust runtime
  }
  if (!body) throw new Error("The provider was not called");
  return body;
}

const compatible = {
  provider: "openai-compatible",
  id: "fixture",
  baseUrl: "http://127.0.0.1:9/v1",
  allowPrivateEndpoint: true,
  contextWindow: 128_000,
  maxTokens: 1024,
} as const;
const anthropic = {
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  apiKey: "fixture-key",
  contextWindow: 200_000,
  maxTokens: 1024,
} as const;

const directChat: AgentRunRequest["history"] = [
  { id: "m1", role: "user", content: "Remember the token kiwi-42." },
  { id: "m2", role: "assistant", content: "Noted: kiwi-42." },
  { id: "m3", role: "user", content: "Thanks." },
  { id: "m4", role: "assistant", content: "You are welcome." },
];
const groupChat: AgentRunRequest["history"] = [
  { id: "m1", role: "user", speaker: "User", content: "Name our project." },
  { id: "m2", role: "assistant", speaker: "Anya", content: "Bluebird." },
  { id: "m3", role: "user", speaker: "User", content: "Thanks." },
  { id: "m4", role: "assistant", content: "Glad to help." },
];

const texts = (messages: WireMessage[]) =>
  messages.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""),
  }));

describe("history on the wire", () => {
  it("sends a direct chat to a chat-completions provider as separate alternating turns", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: directChat,
    });
    expect(texts(body.messages)).toEqual([
      { role: "system", text: expect.stringContaining("Answer briefly.") },
      { role: "user", text: "Remember the token kiwi-42." },
      { role: "assistant", text: "Noted: kiwi-42." },
      { role: "user", text: "Thanks." },
      { role: "assistant", text: "You are welcome." },
      { role: "user", text: "What was the token?" },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("Assistant:");
    expect(JSON.stringify(body.messages)).not.toContain("[User]");
  });

  it("labels other speakers in a group and keeps the labels consistent with the prompt", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: groupChat,
      promptSpeaker: "User",
      prompt: "@Boris who named it?",
    });
    expect(texts(body.messages).slice(1)).toEqual([
      // Anya's reply is another member's, so it merges with the user turns around it.
      {
        role: "user",
        text: "[User]: Name our project.\n\n[Anya]: Bluebird.\n\n[User]: Thanks.",
      },
      { role: "assistant", text: "Glad to help." },
      { role: "user", text: "[User]: @Boris who named it?" },
    ]);
  });

  it("starts with a user turn when the history starts with this bot's own message", async () => {
    const body = await wireBody(compatible, completionsReply, {
      history: [
        { id: "m1", role: "assistant", content: "Welcome, I am Boris." },
        { id: "m2", role: "user", content: "Hi" },
        { id: "m3", role: "assistant", content: "Hello." },
      ],
    });
    expect(texts(body.messages).slice(1)).toEqual([
      { role: "user", text: "[Conversation start]" },
      { role: "assistant", text: "Welcome, I am Boris." },
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "What was the token?" },
    ]);
  });

  it("sends Anthropic a user-first transcript of real turns with the reply text in assistant turns", async () => {
    const body = await wireBody(anthropic, anthropicReply, {
      history: [{ id: "m0", role: "assistant", content: "Welcome." }, ...groupChat],
      promptSpeaker: "User",
    });
    const roles = body.messages.map((message) => message.role);
    expect(roles[0]).toBe("user");
    expect(roles.at(-1)).toBe("user");
    // Anthropic takes consecutive user turns as they are, so each speaker keeps its own turn.
    expect(texts(body.messages)).toEqual([
      { role: "user", text: "[Conversation start]" },
      { role: "assistant", text: "Welcome." },
      { role: "user", text: "[User]: Name our project." },
      { role: "user", text: "[Anya]: Bluebird." },
      { role: "user", text: "[User]: Thanks." },
      { role: "assistant", text: "Glad to help." },
      { role: "user", text: "[User]: What was the token?" },
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("Assistant:");
  });

  it("ends on the prompt as a user turn when the history ends on bot messages", async () => {
    // History that ends on a bot message is followed by the prompt as the final user turn.
    const body = await wireBody(anthropic, anthropicReply, {
      history: [
        { id: "m1", role: "user", content: "Hi" },
        { id: "m2", role: "assistant", speaker: "Anya", content: "Hello from Anya." },
        { id: "m3", role: "assistant", content: "Hello." },
      ],
    });
    expect(texts(body.messages)).toEqual([
      { role: "user", text: "Hi" },
      { role: "user", text: "[Anya]: Hello from Anya." },
      { role: "assistant", text: "Hello." },
      { role: "user", text: "What was the token?" },
    ]);
  });
});
