import type {
  RealtimeVoiceConnection,
  RealtimeVoiceEvent,
  RealtimeVoiceProvider,
} from "@rakazo/adapters";
import type { Actor, RealtimeCallSettings } from "@rakazo/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    listener: undefined as ((event: RealtimeVoiceEvent) => void) | undefined,
    connectInput: undefined as Parameters<RealtimeVoiceProvider["connect"]>[0] | undefined,
    toolResult: vi.fn<(callId: string, output: unknown) => void>(),
    close: vi.fn<() => void>(),
  };
  const provider: RealtimeVoiceProvider = {
    models: [{ id: "model-1", label: "Model 1", capabilities: ["voice", "speed"] }],
    voices: ["voice-a", "voice-b"],
    async connect(input) {
      state.connectInput = input;
      state.toolResult = vi.fn<(callId: string, output: unknown) => void>();
      state.close = vi.fn<() => void>();
      const connection: RealtimeVoiceConnection = {
        answer: "v=0 answer",
        close: state.close,
        onEvent: (listener) => {
          state.listener = listener;
        },
        onClose: vi.fn(),
        toolResult: state.toolResult,
        taskUpdate: vi.fn(),
      };
      return connection;
    },
  };
  return { state, provider, lookUpHistory: vi.fn(), sendThreadMessage: vi.fn(async () => ({})) };
});

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  return {
    ...actual,
    knownVoiceProvider: (id: string) =>
      id === "fake-realtime" ? { realtime: fake.provider } : actual.knownVoiceProvider(id),
    lookUpHistory: fake.lookUpHistory,
    readAgentMemory: vi.fn(async () => [
      { scope: "bot", path: "MEMORY.md", content: "Prefers short answers.", revision: 1 },
    ]),
  };
});
vi.mock("../threads/thread-target.js", () => ({
  resolveThreadTarget: vi.fn(async () => ({
    kind: "bot",
    threadId: "thread-1",
    bot: { name: "Chief", instructions: "Help with the office.", voiceId: null },
  })),
  sendThreadMessage: fake.sendThreadMessage,
  threadHead: vi.fn(async () => ({ cursor: 0 })),
}));
vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    createThreadMessageInTransaction: vi.fn(async () => ({ id: "message-1" })),
    appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
  };
});
vi.mock("../bots/taught-skills.js", () => ({ assertTeachingSendAllowed: vi.fn(async () => {}) }));
vi.mock("./voice.js", () => ({
  loadVoiceCredential: vi.fn(async () => ({
    apiKey: "sk-call",
    deployment: false,
    cred: { provider: "fake-realtime", voiceId: "voice-b" },
  })),
}));

const { mountRealtimeVoiceRoutes, realtimeHistory, realtimeInstructions } = await import(
  "./realtime-voice.js"
);
const { realtimeCallState, saveRealtimeCallSettings } = await import("./realtime-settings.js");
const { chosenRealtimeModel } = await import("@rakazo/contracts");

function textMessage(role: string, text: string) {
  return { role, blocks: [{ kind: "text", text }] } as never;
}

function prisma(options: { stored?: unknown; providers?: string[] } = {}) {
  return {
    user: {
      findUnique: vi.fn(async () => ({ realtimeCall: options.stored ?? null })),
      update: vi.fn(async () => ({})),
    },
    userVoiceCredential: {
      findMany: vi.fn(async () =>
        (options.providers ?? ["fake-realtime"]).map((provider) => ({ provider })),
      ),
    },
    message: {
      findMany: vi.fn(async () => [
        textMessage("bot", "Bis morgen."),
        textMessage("user", "Danke, das reicht."),
      ]),
    },
  };
}

describe("realtime call context", () => {
  it("starts the call with the chat in order, text only", () => {
    const history = realtimeHistory([
      textMessage("bot", "Second"),
      { role: "user", blocks: [{ kind: "file", name: "plan.pdf" }] } as never,
      textMessage("system", "Not dialogue"),
      textMessage("user", "First"),
      textMessage("user", "x".repeat(2500)),
    ]);
    expect(history.map((item) => [item.role, item.text.length])).toEqual([
      ["user", 2000],
      ["user", 5],
      ["bot", 6],
    ]);
  });

  it("gives the model the bot, its memory and where older messages are", () => {
    const text = realtimeInstructions({
      botName: "Chief",
      botInstructions: "y".repeat(7000),
      memory: "Memory: prefers short answers.",
    });
    expect(text).toContain("You speak as Chief");
    expect(text).toContain("search_history and read_history");
    expect(text).toContain("Memory: prefers short answers.");
    expect(text).not.toContain("y".repeat(6001));
  });
});

describe("realtime call settings", () => {
  const actor = { userId: "user" };

  it("offers realtime from any connected provider, whichever voice reads replies aloud", async () => {
    const state = await realtimeCallState(
      prisma({ providers: ["elevenlabs", "fake-realtime"] }) as never,
      actor,
      true,
    );
    expect(state.available).toBe(true);
    expect(state.providers.map((entry) => entry.provider)).toEqual(["fake-realtime"]);
  });

  it("stays unavailable while the server has calls switched off", async () => {
    const state = await realtimeCallState(prisma() as never, actor, false);
    expect(state).toMatchObject({ available: false, providers: [] });
  });

  it("falls back to the standard call when stored settings no longer parse", async () => {
    const state = await realtimeCallState(prisma({ stored: { speed: 9 } }) as never, actor, true);
    expect(state.settings).toEqual({ provider: "", model: "" });
    expect(chosenRealtimeModel(state)).toBeNull();
  });

  it("chooses only a model the provider still offers", async () => {
    const pick = async (stored: Partial<RealtimeCallSettings>) =>
      chosenRealtimeModel(await realtimeCallState(prisma({ stored }) as never, actor, true));
    expect((await pick({ provider: "fake-realtime", model: "model-1" }))?.model.id).toBe("model-1");
    expect((await pick({ model: "model-1" }))?.provider).toBe("fake-realtime");
    expect(await pick({ provider: "fake-realtime", model: "retired" })).toBeNull();
  });

  it("refuses a model or voice the connected provider does not offer", async () => {
    const db = prisma();
    await expect(
      saveRealtimeCallSettings(db as never, actor, true, {
        provider: "fake-realtime",
        model: "nope",
      }),
    ).rejects.toThrow("Connect a voice provider");
    await expect(
      saveRealtimeCallSettings(db as never, actor, true, {
        provider: "fake-realtime",
        model: "model-1",
        voiceId: "voice-z",
      }),
    ).rejects.toThrow("not available for calls");
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("stores only the chosen settings, and the standard call always", async () => {
    const db = prisma({ providers: [] });
    await saveRealtimeCallSettings(db as never, actor, true, { provider: "", model: "" });
    const chosen = prisma();
    await saveRealtimeCallSettings(chosen as never, actor, true, {
      provider: "fake-realtime",
      model: "model-1",
      speed: 1.1,
      language: undefined,
    });
    expect(chosen.user.update).toHaveBeenCalledWith({
      where: { id: "user" },
      data: { realtimeCall: { provider: "fake-realtime", model: "model-1", speed: 1.1 } },
    });
  });
});

describe("realtime call tools", () => {
  const signedIn = { userId: "user", spaceId: "space-a" } as Actor;
  let recheck: Actor;

  beforeEach(() => {
    fake.lookUpHistory.mockReset();
    fake.sendThreadMessage.mockClear();
    recheck = signedIn;
  });

  async function openCall(stored: unknown = { provider: "fake-realtime", model: "model-1" }) {
    const app = new Hono();
    const authenticate = vi.fn(async (_c: unknown, again?: boolean) =>
      again ? recheck : signedIn,
    );
    mountRealtimeVoiceRoutes(
      app,
      {
        prisma: {
          ...prisma({ stored }),
          $transaction: async (work: (tx: unknown) => unknown) => work({}),
        },
        memory: {},
        events: {
          notify: vi.fn(async () => {}),
          follow: async function* () {},
        },
      } as never,
      authenticate as never,
      (origin) => origin === "http://localhost",
      true,
      new AbortController().signal,
    );
    return app.request("/api/voice/realtime", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: JSON.stringify({ botId: "bot-1", callId: "call-1", offer: "v=0 offer" }),
    });
  }

  async function callTool(name: string, args: string) {
    fake.state.listener?.({
      kind: "responseDone",
      responseId: "response-1",
      toolCalls: [{ id: "tool-1", name, args }],
    });
    await vi.waitFor(() => expect(fake.state.toolResult).toHaveBeenCalled());
    const [id, output] = fake.state.toolResult.mock.calls[0] ?? [];
    return [id, output] as const;
  }

  it("keeps the standard call when no realtime model is chosen", async () => {
    expect((await openCall({ provider: "", model: "" })).status).toBe(409);
  });

  it("opens the call with settings, chat, memory and the read-only tools", async () => {
    const response = await openCall({ provider: "fake-realtime", model: "model-1", speed: 1.2 });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("v=0 answer");
    const input = fake.state.connectInput;
    expect(input?.settings).toMatchObject({ model: "model-1", speed: 1.2 });
    expect(input?.history).toEqual([
      { role: "user", text: "Danke, das reicht." },
      { role: "bot", text: "Bis morgen." },
    ]);
    expect(input?.instructions).toContain("Prefers short answers.");
    expect(input?.tools.map((tool) => tool.name)).toEqual([
      "ask_bot",
      "search_history",
      "read_history",
    ]);
  });

  it("looks up history only in this call's chat and space", async () => {
    fake.lookUpHistory.mockResolvedValue({ response: {}, redacted: { messages: ["hit"] } });
    await openCall();
    const [id, output] = await callTool("search_history", '{"query":"Meeting"}');
    expect([id, output]).toEqual(["tool-1", { messages: ["hit"] }]);
    expect(fake.lookUpHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        spaceId: "space-a",
        threadId: "thread-1",
        botId: "bot-1",
        allowMyChats: false,
      }),
      "search_history",
      { query: "Meeting" },
      ["sk-call"],
    );
  });

  it("ends the call instead of reading history once the session belongs to another space", async () => {
    await openCall();
    recheck = { userId: "user", spaceId: "space-b" } as Actor;
    fake.state.listener?.({
      kind: "responseDone",
      responseId: "response-1",
      toolCalls: [{ id: "tool-1", name: "read_history", args: '{"messageId":"m1"}' }],
    });
    await vi.waitFor(() => expect(fake.state.close).toHaveBeenCalled());
    expect(fake.lookUpHistory).not.toHaveBeenCalled();
    expect(fake.state.toolResult).not.toHaveBeenCalled();
  });

  it("answers malformed arguments and unknown tools without running anything", async () => {
    await openCall();
    expect((await callTool("search_history", "not json"))[1]).toEqual({
      error: "Arguments must be a JSON object.",
    });
    await openCall();
    expect((await callTool("delete_everything", "{}"))[1]).toEqual({ error: "Unknown tool." });
    expect(fake.lookUpHistory).not.toHaveBeenCalled();
  });
  it("falls back to the connection's saved voice when neither bot nor call voice is set", async () => {
    await openCall();
    expect(fake.state.connectInput?.voiceId).toBe("voice-b");
  });

  it("offers the call only this chat and no run outcomes", async () => {
    await openCall();
    const [search, read] = fake.state.connectInput?.tools.slice(1) ?? [];
    if (!search || !read) throw new Error("Expected both history tools");
    expect(search.description).not.toContain("my_chats");
    expect((search.parameters.properties as Record<string, unknown>).scope).toEqual({
      type: "string",
      enum: ["this_chat"],
    });
    expect(Object.keys(read.parameters.properties as object)).not.toContain("linkedRunId");
    expect((await callTool("search_history", '{"query":"Plan","scope":"my_chats"}'))[1]).toEqual({
      error: "Only this chat can be searched during a call; use this_chat.",
    });
    await openCall();
    expect((await callTool("read_history", '{"messageId":"m1","linkedRunId":"r1"}'))[1]).toEqual({
      error: "Run outcomes and attachments can be read in the chat, not in a call.",
    });
    expect(fake.lookUpHistory).not.toHaveBeenCalled();
  });

  it("hands the spoken request to the bot through its chat, as before", async () => {
    await openCall();
    const emit = (event: RealtimeVoiceEvent) => fake.state.listener?.(event);
    emit({ kind: "turn", itemId: "item-1" });
    emit({ kind: "responseStart", responseId: "response-1" });
    emit({
      kind: "responseDone",
      responseId: "response-1",
      toolCalls: [{ id: "task-1", name: "ask_bot", args: "{}" }],
    });
    emit({ kind: "transcript", role: "user", itemId: "item-1", text: "Plane den Morgen" });
    await vi.waitFor(() => expect(fake.state.toolResult).toHaveBeenCalled());
    expect(fake.sendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      signedIn,
      expect.objectContaining({ threadId: "thread-1" }),
      { text: "Plane den Morgen", clientNonce: "realtime-task:call-1:item-1" },
    );
    expect(fake.state.toolResult).toHaveBeenCalledWith("task-1", {
      status:
        "The bot is working on this in the Rakazo chat. Acknowledge briefly and continue the conversation.",
    });
  });

  it("drops a bot hand-off from a turn the caller has already moved on from", async () => {
    await openCall();
    const emit = (event: RealtimeVoiceEvent) => fake.state.listener?.(event);
    emit({ kind: "turn", itemId: "item-1" });
    emit({ kind: "responseStart", responseId: "response-1" });
    emit({ kind: "turn", itemId: "item-2" });
    emit({
      kind: "responseDone",
      responseId: "response-1",
      toolCalls: [{ id: "task-1", name: "ask_bot", args: "{}" }],
    });
    await vi.waitFor(() =>
      expect(fake.state.toolResult).toHaveBeenCalledWith("task-1", {
        status: "The previous voice turn ended.",
      }),
    );
    expect(fake.sendThreadMessage).not.toHaveBeenCalled();
  });
});
