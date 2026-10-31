import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  initialMessages: [] as Array<Record<string, unknown>>,
  prompt: undefined as string | undefined,
  options: undefined as { prepareNextTurnWithContext?: () => Promise<unknown> } | undefined,
  steered: [] as Array<Record<string, unknown>>,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    constructor(options: {
      initialState: { messages: Array<Record<string, unknown>> };
      prepareNextTurnWithContext?: () => Promise<unknown>;
    }) {
      captured.initialMessages = options.initialState.messages;
      captured.options = options;
    }
    subscribe() {}
    steer(message: Record<string, unknown>) {
      captured.steered.push(message);
    }
    async prompt(input: string) {
      captured.prompt = input;
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => ({ provider: "test", id: modelId }),
    streamSimple: () => {
      throw new Error("provider should not be called");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

async function replay(overrides: Partial<AgentRunRequest>) {
  const request: AgentRunRequest = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Next question.",
    instructions: "test",
    history: [],
    tools: [],
    model: { provider: "test", id: "history-test-model" },
    ...overrides,
  };
  for await (const _event of new PiAgentRuntime().run(request, {
    operationId: "history-test",
    traceId: "history-test",
    spaceId: "workspace",
    userId: "user",
    signal: new AbortController().signal,
  })) {
    // exhaust runtime
  }
  return captured.initialMessages;
}

const view = (messages: Array<Record<string, unknown>>) =>
  messages.map((message) => ({
    role: message.role,
    content:
      Array.isArray(message.content) && message.role === "assistant"
        ? (message.content as Array<{ text: string }>).map((part) => part.text).join("")
        : message.content,
  }));

describe("Pi history replay", () => {
  beforeEach(() => {
    captured.initialMessages = [];
    captured.prompt = undefined;
    captured.options = undefined;
    captured.steered = [];
  });

  it("replays a direct chat as alternating user and assistant turns without a prefix", async () => {
    const messages = await replay({
      history: [
        { id: "m1", role: "user", content: "Remember the token kiwi-42." },
        { id: "m2", role: "assistant", content: "Noted: kiwi-42." },
        { id: "m3", role: "user", content: "Thanks." },
        { id: "m4", role: "assistant", content: "You are welcome." },
      ],
    });
    expect(view(messages)).toEqual([
      { role: "user", content: "Remember the token kiwi-42." },
      { role: "assistant", content: "Noted: kiwi-42." },
      { role: "user", content: "Thanks." },
      { role: "assistant", content: "You are welcome." },
    ]);
    expect(JSON.stringify(messages)).not.toContain("Assistant:");
    expect(captured.prompt).toBe("Next question.");
  });

  it("gives an own reply the shape of a finished text-only assistant message from another model", async () => {
    const [, reply] = await replay({
      history: [
        { id: "m1", role: "user", content: "Hi", createdAt: "2026-01-02T03:04:05.000Z" },
        { id: "m2", role: "assistant", content: "Hello", createdAt: "2026-01-02T03:04:06.000Z" },
      ],
    });
    expect(reply).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      api: "rakazo-history",
      provider: "rakazo-history",
      model: "history",
      usage: expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
      stopReason: "stop",
      timestamp: Date.parse("2026-01-02T03:04:06.000Z"),
      rakazoHistory: true,
      rakazoMessageId: "m2",
      rakazoCreatedAt: "2026-01-02T03:04:06.000Z",
    });
  });

  it("replays the same messages identically every time, for prompt caching", async () => {
    const history = [
      { id: "m1", role: "user" as const, content: "Hi", createdAt: "2026-01-02T03:04:05.000Z" },
      { id: "m2", role: "assistant" as const, content: "Hello" },
    ];
    const first = JSON.stringify(await replay({ history }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(JSON.stringify(await replay({ history }))).toBe(first);
  });

  it("labels other members as user turns and keeps this bot's own replies unlabelled", async () => {
    const messages = await replay({
      promptSpeaker: "User",
      prompt: "@Boris who named the project?",
      history: [
        { id: "m1", role: "user", speaker: "User", content: "Name our project." },
        { id: "m2", role: "assistant", speaker: "Anya", content: "Bluebird." },
        { id: "m3", role: "user", speaker: "User", content: "Thanks Anya." },
        { id: "m4", role: "assistant", content: "I will remember that." },
      ],
    });
    expect(view(messages)).toEqual([
      { role: "user", content: "[User]: Name our project." },
      { role: "user", content: "[Anya]: Bluebird." },
      { role: "user", content: "[User]: Thanks Anya." },
      { role: "assistant", content: "I will remember that." },
    ]);
    expect(captured.prompt).toBe("[User]: @Boris who named the project?");
    expect(JSON.stringify(messages)).not.toContain("Assistant:");
  });

  it("leaves the current prompt bare in a direct chat", async () => {
    await replay({ prompt: "Plain prompt." });
    expect(captured.prompt).toBe("Plain prompt.");
  });

  it("keeps a note inside another bot's labelled turn", async () => {
    const messages = await replay({
      history: [
        {
          id: "m1",
          role: "assistant",
          speaker: "Anya",
          content: "Half an answ\n\n[This reply was cut off.]",
        },
      ],
    });
    expect(view(messages)).toEqual([
      { role: "user", content: "[Anya]: Half an answ\n\n[This reply was cut off.]" },
    ]);
  });

  it("keeps pictures on the human's turn and out of bot turns", async () => {
    const image = { name: "a.png", mimeType: "image/png" as const, data: new Uint8Array([1, 2]) };
    const messages = await replay({
      history: [
        { id: "m1", role: "user", speaker: "User", content: "[image: a.png]", images: [image] },
        {
          id: "m2",
          role: "assistant",
          speaker: "Anya",
          content: "[image: b.png]",
          images: [image],
        },
        { id: "m3", role: "assistant", content: "Nice picture.", images: [image] },
      ],
    });
    expect(messages[0]!.content).toEqual([
      { type: "text", text: "[User]: [image: a.png]" },
      { type: "image", data: Buffer.from([1, 2]).toString("base64"), mimeType: "image/png" },
    ]);
    expect(messages[1]!.content).toBe("[Anya]: [image: b.png]");
    expect(messages[2]!.content).toEqual([{ type: "text", text: "Nice picture." }]);
  });

  it("starts on a bot message and ends on one without inventing turns of its own", async () => {
    const messages = await replay({
      history: [
        { id: "m1", role: "assistant", content: "Welcome, I am Boris." },
        { id: "m2", role: "user", content: "Hi" },
        { id: "m3", role: "assistant", content: "Hello." },
      ],
    });
    // The opening turn for a window that starts on a bot message is added per model call, so
    // the stored transcript is exactly the history.
    expect(view(messages).map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("drops a reply with no text instead of sending an empty assistant turn", async () => {
    const messages = await replay({
      history: [
        { id: "m1", role: "user", content: "Do it" },
        { id: "m2", role: "assistant", content: "  " },
        { id: "m3", role: "system", content: "internal" },
      ],
    });
    expect(view(messages)).toEqual([{ role: "user", content: "Do it" }]);
  });

  it("removes the current message from history by id or by raw text, whatever its label", async () => {
    const labelled = {
      id: "current",
      role: "user" as const,
      speaker: "User",
      content: "Question?",
    };
    const earlier = { id: "m1", role: "assistant" as const, speaker: "Anya", content: "Earlier." };
    expect(
      view(
        await replay({
          prompt: "Question?",
          sourceMessageId: "current",
          history: [earlier, labelled],
        }),
      ),
    ).toEqual([{ role: "user", content: "[Anya]: Earlier." }]);
    expect(
      view(
        await replay({ prompt: "Question?", history: [earlier, { ...labelled, id: undefined }] }),
      ),
    ).toEqual([{ role: "user", content: "[Anya]: Earlier." }]);
  });

  it("drops a claimed steering message from history by id, not by its label", async () => {
    const messages = await replay({
      claimSteering: async () => [
        { id: "claim-1", messageId: "steer-1", text: "Also check B.", origin: "user" },
      ],
      history: [
        { id: "m1", role: "user", speaker: "User", content: "Check A." },
        { id: "steer-1", role: "user", speaker: "User", content: "Also check B." },
      ],
    });
    expect(view(messages)).toEqual([{ role: "user", content: "[User]: Check A." }]);
  });

  it("labels the person's mid-run messages like the prompt in a group, and not elsewhere", async () => {
    const claims = [
      [{ id: "c1", messageId: "s1", text: "Also check B.", origin: "user" as const }],
      [{ id: "c2", messageId: "s2", text: "And C.", origin: "user" as const }],
      [{ id: "c3", messageId: "s3", text: "From a peer.", origin: "member" as const }],
    ];
    const claimSteering = async () => claims.shift() ?? [];
    await replay({ promptSpeaker: "User", prompt: "Check A.", claimSteering });
    expect(captured.prompt).toBe(
      "[User]: Check A.\n\nAdditional user context:\n[User]: Also check B.",
    );
    await captured.options!.prepareNextTurnWithContext!();
    await captured.options!.prepareNextTurnWithContext!();
    expect(captured.steered.map((message) => message.content)).toEqual([
      expect.stringContaining("[User]: And C."),
      expect.stringContaining("A message arrived from another member of this chat"),
    ]);
    expect(String(captured.steered[1]!.content)).not.toContain("[User]");
  });

  it("leaves a direct chat's mid-run messages bare", async () => {
    const claims = [
      [{ id: "c1", messageId: "s1", text: "Also check B.", origin: "user" as const }],
      [{ id: "c2", messageId: "s2", text: "And C.", origin: "user" as const }],
    ];
    await replay({
      prompt: "Check A.",
      claimSteering: async () => claims.shift() ?? [],
    });
    expect(captured.prompt).toBe("Check A.\n\nAdditional user context:\nAlso check B.");
    await captured.options!.prepareNextTurnWithContext!();
    expect(String(captured.steered[0]!.content)).toContain("And C.");
    expect(String(captured.steered[0]!.content)).not.toContain("[User]");
  });
});
