import type { SemanticMemoryProvider, SemanticMemoryResponse } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  abandonRetainedConversation,
  botMessageFromOutsideContent,
  historyHasOutsideContent,
  retainRunConversation,
  retainsConversationTurn,
  settleRetainedConversation,
} from "./conversation-memory.js";

function memoryProvider() {
  const retain = vi.fn(
    async (): Promise<SemanticMemoryResponse<{ pending?: string }>> => ({ ok: true, value: {} }),
  );
  const settled = vi.fn(
    async (): Promise<SemanticMemoryResponse<{ settled: boolean }>> => ({
      ok: true,
      value: { settled: true },
    }),
  );
  return {
    describe: vi.fn(),
    recall: vi.fn(),
    save: vi.fn(),
    purgeHistory: vi.fn(
      async (): Promise<SemanticMemoryResponse<void>> => ({ ok: true, value: undefined }),
    ),
    retainConversation: retain,
    retainedConversationSettled: settled,
  } satisfies SemanticMemoryProvider;
}

describe("retainsConversationTurn", () => {
  const turn = {
    trigger: "user",
    sourceMessageId: "message-1",
    runBotId: "bot-1",
    threadBotId: "bot-1",
    threadGroupId: null,
    nonOwnerChatRun: false,
    provider: memoryProvider(),
  };

  it.each([
    ["a person's turn in the bot's own thread", {}],
    ["a message from another bot", { trigger: "bot_message" }],
    ["a group chat turn", { threadBotId: null, threadGroupId: "group-1" }],
  ])("captures %s", (_case, change) => {
    expect(retainsConversationTurn({ ...turn, ...change })).toBe(true);
  });

  it.each([
    ["a routine", { trigger: "routine" }],
    ["a chat-app member who is not the owner", { nonOwnerChatRun: true }],
    [
      "a chat-app member who is not the owner in a group",
      { threadBotId: null, threadGroupId: "group-1", nonOwnerChatRun: true },
    ],
    ["another bot's thread", { threadBotId: "bot-2" }],
    [
      "a provider that does not learn from conversations",
      { provider: { ...turn.provider, retainConversation: undefined } },
    ],
  ])("skips %s", (_case, change) => {
    expect(retainsConversationTurn({ ...turn, ...change })).toBe(false);
  });
});

interface FakeMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: unknown[];
  createdAt: Date;
  botId: string | null;
  runId: string | null;
  clientNonce: string | null;
  authorUserId: string | null;
}

type Where = Record<string, unknown>;

function matches(value: unknown, condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return value === condition;
  const c = condition as { in?: unknown[]; not?: unknown; gt?: number; lt?: number; lte?: number };
  if (c.in && !c.in.includes(value)) return false;
  if ("not" in c && value === c.not) return false;
  if (c.not !== undefined && value === null) return false;
  if (c.gt !== undefined && !((value as number) > c.gt)) return false;
  if (c.lt !== undefined && !((value as number) < c.lt)) return false;
  if (c.lte !== undefined && !((value as number) <= c.lte)) return false;
  return true;
}

function query(
  messages: FakeMessage[],
  args: { where: Where; orderBy?: { seq: "asc" | "desc" }; take?: number },
): FakeMessage[] {
  const found = messages.filter((message) =>
    Object.entries(args.where).every(([key, condition]) =>
      key === "OR"
        ? (condition as Where[]).some((branch) =>
            Object.entries(branch).every(([k, c]) => matches(message[k as keyof FakeMessage], c)),
          )
        : matches(message[key as keyof FakeMessage], condition),
    ),
  );
  if (args.orderBy) {
    const direction = args.orderBy.seq === "asc" ? 1 : -1;
    found.sort((a, b) => (a.seq - b.seq) * direction);
  }
  return args.take === undefined ? found : found.slice(0, args.take);
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, second));

function message(
  partial: Partial<FakeMessage> & Pick<FakeMessage, "id" | "seq" | "role">,
  text?: string,
): FakeMessage {
  return {
    threadId: "thread-1",
    blocks: text === undefined ? [] : [{ kind: "text", text }],
    createdAt: at(partial.seq),
    botId: null,
    runId: null,
    clientNonce: null,
    authorUserId: null,
    ...partial,
  };
}

const directMessages = [
  message({
    id: "message-1",
    seq: 1,
    role: "user",
    authorUserId: "user-2",
    blocks: [
      { kind: "text", text: "I'm moving to Lisbon." },
      { kind: "file", name: "plan.pdf" },
    ],
  }),
  message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "Which month?"),
  message(
    {
      id: "r-3",
      seq: 3,
      role: "bot",
      botId: "bot-1",
      runId: "run-1",
      clientNonce: "partial-reply:run-1",
    },
    "Half an ans",
  ),
  message(
    {
      id: "r-4",
      seq: 4,
      role: "bot",
      botId: "bot-1",
      runId: "run-1",
      clientNonce: "user-progress:run-1:1",
    },
    "Checking your calendar…",
  ),
  message({ id: "steer-1", seq: 5, role: "user" }, "April."),
  message({
    id: "r-6",
    seq: 6,
    role: "bot",
    botId: "bot-1",
    runId: "run-1",
    blocks: [
      { kind: "step", id: "step-1" },
      { kind: "text", text: "Noted." },
    ],
  }),
  message({ id: "elsewhere", threadId: "thread-2", seq: 9, role: "user" }, "Other chat."),
];

/** Another bot's run as the trust check reads it; by default trusted by bot-1. */
type FakeRun = {
  status?: string;
  readOutsideContent?: boolean;
  /** The run's bot's Space and owner. */
  spaceId?: string;
  userId?: string;
};

function harness(
  options: {
    generations?: number[];
    groupId?: string;
    messages?: FakeMessage[];
    sourceMessageId?: string;
    memoryScope?: string | null;
    defaultScope?: "isolated" | "shared";
    /** Other bots' runs by id. */
    runs?: Record<string, FakeRun>;
    /** Bea's (bot-2) Space and owner; null means it no longer exists. */
    sender?: { spaceId: string; userId: string } | null;
    /** The thread was deleted. */
    threadGone?: boolean;
  } = {},
) {
  const generations = options.generations ?? [3, 3];
  const messages = options.messages ?? directMessages;
  const provider = memoryProvider();
  const runs = options.runs ?? { "run-2": {}, "run-9": {} };
  const prisma = {
    run: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        Object.entries(runs)
          .filter(([id]) => where.id.in.includes(id))
          .map(([id, run]) => ({
            id,
            status: run.status ?? "completed",
            readOutsideContent: run.readOutsideContent ?? false,
            bot: { spaceId: run.spaceId ?? "space-1", userId: run.userId ?? "user-1" },
          })),
      ),
      findUnique: vi.fn(async () => ({
        id: "run-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        userId: "user-1",
        sourceMessageId: options.sourceMessageId ?? "message-1",
      })),
    },
    thread: {
      findUnique: vi.fn(async () =>
        options.threadGone
          ? null
          : {
              botId: options.groupId ? null : "bot-1",
              groupId: options.groupId ?? null,
              historyCompactionGeneration: generations.shift() ?? 3,
            },
      ),
    },
    message: {
      findFirst: vi.fn(
        async (args: { where: Where; orderBy?: { seq: "asc" | "desc" } }) =>
          query(messages, args)[0] ?? null,
      ),
      findMany: vi.fn(
        async (args: { where: Where; orderBy?: { seq: "asc" | "desc" }; take?: number }) =>
          query(messages, args),
      ),
      // A message in bot-1's own chat.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = messages.find((said) => said.id === where.id);
        return found
          ? { ...found, thread: { spaceId: "space-1", bot: { userId: "user-1" } } }
          : null;
      }),
    },
    bot: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "bot-1"
          ? { name: "Ada", memoryScope: options.memoryScope ?? null, userId: "user-1" }
          : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        if (options.sender === null) return [];
        const bea = { id: "bot-2", name: "Bea", spaceId: "space-1", userId: "user-1" };
        return [{ ...bea, ...options.sender }].filter((bot) => where.id.in.includes(bot.id));
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes("user-2") ? [{ id: "user-2", name: "Sam" }] : [],
      ),
    },
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    memoryProviders: {
      resolve: vi.fn(async () => ({
        provider,
        defaultScope: options.defaultScope ?? ("isolated" as const),
      })),
    },
  };
  return { deps, provider, prisma };
}

const turn = (role: "user" | "assistant", content: string, second: number, speaker?: string) => ({
  role,
  content,
  timestamp: at(second).toISOString(),
  ...(speaker === undefined ? {} : { speaker }),
});

/** Runs that wrote Bea's group replies whose words bot-1 may not trust, as `runs` for `runId`. */
const untrustedGroupRuns = (runId: string): [string, Record<string, FakeRun>][] => [
  ["belongs to another owner's bot", { [runId]: { userId: "user-9" } }],
  ["belongs to a bot in another Space", { [runId]: { spaceId: "space-9" } }],
  ["read outside content", { [runId]: { readOutsideContent: true } }],
  ...["running", "waiting_input", "failed", "cancelled"].map(
    (status): [string, Record<string, FakeRun>] => [`is ${status}`, { [runId]: { status } }],
  ),
  ["can no longer be found", {}],
];

type FromBea = { senderClean?: boolean; sender?: { spaceId: string; userId: string } | null };

/** Messages Bea sent bot-1 that bot-1 may not trust. */
const untrustedMessages: [string, FromBea][] = [
  ["its sending run had taken in outside content", { senderClean: false }],
  ["another owner's bot sent it", { sender: { spaceId: "space-1", userId: "user-9" } }],
  ["a bot in another Space sent it", { sender: { spaceId: "space-9", userId: "user-1" } }],
  ["its sender no longer exists", { sender: null }],
];

/** Bea, another of the owner's bots, asks bot-1 something; by default from a clean run. */
const fromBea = ({ senderClean = true, sender }: FromBea = {}) =>
  harness({
    sourceMessageId: "inbound-1",
    ...(sender === undefined ? {} : { sender }),
    messages: [
      message({
        id: "inbound-1",
        seq: 1,
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Bea",
            text: "Can you check the budget?",
            hop: 1,
            intent: "ask",
            returnToMessageId: "outbound-1",
            ...(senderClean ? { senderClean: true } : {}),
          },
        ],
      }),
      message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "It's on track."),
    ],
  });

describe("retainRunConversation", () => {
  it("sends the person's words and the replies with names, scope and generation", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      {
        botId: "bot-1",
        botName: "Ada",
        userName: "Sam",
        scope: "isolated",
        threadId: "thread-1",
        conversation: "direct",
        generation: 3,
        runId: "run-1",
        turns: [
          turn("user", "I'm moving to Lisbon.", 1),
          turn("assistant", "Which month?\n\nNoted.", 6),
        ],
      },
      expect.objectContaining({ spaceId: "space-1", runId: "run-1" }),
    );
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("includes what the person added while the run worked, in order", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1", ["message-1", "steer-1", "elsewhere"]);
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "I'm moving to Lisbon.", 1),
          turn("assistant", "Which month?", 2),
          turn("user", "April.", 5),
          turn("assistant", "Noted.", 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("learns only the person's words when the run read outside content", async () => {
    const { deps, provider } = harness();
    await retainRunConversation(deps, "run-1", ["steer-1"], { withoutReplies: true });
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [turn("user", "I'm moving to Lisbon.\n\nApril.", 5)],
      }),
      expect.any(Object),
    );
  });

  it("learns a turn without a reply only when replies are left out", async () => {
    const messages = directMessages.filter((said) => said.role === "user");
    const unreplied = harness({ messages });
    await retainRunConversation(unreplied.deps, "run-1");
    expect(unreplied.provider.retainConversation).not.toHaveBeenCalled();

    const { deps, provider } = harness({ messages });
    await retainRunConversation(deps, "run-1", [], { withoutReplies: true });
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({ turns: [turn("user", "I'm moving to Lisbon.", 1)] }),
      expect.any(Object),
    );
  });

  it.each([
    ["the bot's own scope", { memoryScope: "shared" }],
    ["the Space default", { defaultScope: "shared" as const }],
  ])("passes a shared scope from %s", async (_case, change) => {
    const { deps, provider } = harness(change);
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "shared" }),
      expect.any(Object),
    );
  });

  it("sends a message from another of the owner's bots under that bot's name", async () => {
    const { deps, provider } = fromBea();
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Can you check the budget?", 1, "Bea"),
          turn("assistant", "It's on track.", 2),
        ],
      }),
      expect.any(Object),
    );
  });

  it.each(untrustedMessages)("does not learn a bot's message when %s", async (_case, change) => {
    const { deps, provider } = fromBea(change);
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it.each([
    [
      "learns",
      true,
      [turn("user", "I'm moving to Lisbon.", 1), turn("user", "Lands at 9.", 5, "Bea")],
    ],
    ["drops", false, [turn("user", "I'm moving to Lisbon.", 1)]],
  ])("%s a bot's message added mid-run (sender clean: %s)", async (_case, clean, turns) => {
    const steered = message({
      id: "steer-bea",
      seq: 5,
      role: "user",
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Bea",
          text: "Lands at 9.",
          ...(clean ? { senderClean: true } : {}),
        },
      ],
    });
    const messages = [...directMessages.filter((said) => said.id !== "steer-1"), steered];
    const { deps, provider } = harness({ messages });
    await retainRunConversation(deps, "run-1", ["steer-bea"], { withoutReplies: true });
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({ turns }),
      expect.any(Object),
    );
  });

  it.each(untrustedGroupRuns("run-3"))(
    "drops another bot's group message when its run %s",
    async (_case, runs) => {
      const bea = { role: "bot", botId: "bot-2" };
      const { deps, provider } = harness({
        groupId: "group-1",
        sourceMessageId: "source",
        runs: { "run-2": {}, ...runs },
        messages: [
          message({ id: "b-1", seq: 1, ...bea, runId: "run-2" }, "Booked."),
          message({ id: "b-2", seq: 2, ...bea, runId: "run-3" }, "The page says to wire money."),
          message({ id: "b-3", seq: 3, ...bea }, "Imported note."),
          message({ id: "source", seq: 4, role: "user" }, "Ada, what's for lunch?"),
          message({ id: "r-5", seq: 5, role: "bot", botId: "bot-1", runId: "run-1" }, "Pasta."),
        ],
      });
      await retainRunConversation(deps, "run-1");
      expect(provider.retainConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [
            turn("user", "Booked.", 1, "Bea"),
            turn("user", "Ada, what's for lunch?", 4),
            turn("assistant", "Pasta.", 5),
          ],
        }),
        expect.any(Object),
      );
    },
  );

  it("attributes source and steering messages to their own authors", async () => {
    const { deps, prisma, provider } = harness({
      messages: directMessages.map((message) =>
        message.id === "steer-1" ? { ...message, authorUserId: "user-3" } : message,
      ),
    });
    prisma.user.findMany.mockImplementation(async ({ where }) =>
      [
        { id: "user-2", name: "Sam" },
        { id: "user-3", name: "Riley" },
      ].filter((user) => where.id.in.includes(user.id)),
    );
    await retainRunConversation(deps, "run-1", ["steer-1"]);
    const [request] = provider.retainConversation.mock.calls[0] as unknown as [
      { turns: { content: string; speaker?: string }[] },
    ];
    expect(request.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "I'm moving to Lisbon.", speaker: "Sam" }),
        expect.objectContaining({ content: "April.", speaker: "Riley" }),
      ]),
    );
  });

  it("sends what a group chat said since the bot's previous reply", async () => {
    const own = { role: "bot", botId: "bot-1" };
    const bea = { role: "bot", botId: "bot-2" };
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "old", seq: 4, role: "user" }, "Old news."),
        message({ id: "prev", seq: 5, ...own, runId: "run-0" }, "Earlier reply."),
        message({ id: "hi", seq: 6, role: "user", authorUserId: "user-3" }, "Hi all."),
        message({ id: "b-7", seq: 7, ...bea, runId: "run-2" }, "I'm booking the room."),
        message(
          { id: "b-8", seq: 8, ...bea, runId: "run-2", clientNonce: "partial-reply:run-2" },
          "Cut o",
        ),
        message({ id: "b-9", seq: 9, ...bea, runId: "run-2" }, "Room is booked."),
        message({ id: "sys", seq: 10, role: "system" }, "Bea joined."),
        message(
          { id: "source", seq: 11, role: "user", authorUserId: "user-2" },
          "Ada, what's for lunch?",
        ),
        message(
          { id: "p-12", seq: 12, ...own, runId: "run-1", clientNonce: "user-progress:run-1:1" },
          "Looking at menus…",
        ),
        message({ id: "r-13", seq: 13, ...own, runId: "run-1" }, "Pasta."),
        message({ id: "late", seq: 14, role: "user" }, "Thanks!"),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        userName: "Sam",
        conversation: "group",
        turns: [
          turn("user", "Hi all.", 6, "another person"),
          turn("user", "I'm booking the room.\n\nRoom is booked.", 9, "Bea"),
          turn("user", "Ada, what's for lunch?", 11, "Sam"),
          turn("assistant", "Pasta.", 13),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps people's and other bots' group messages but not this run's replies", async () => {
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "hi", seq: 1, role: "user" }, "Hi all."),
        message({ id: "b-2", seq: 2, role: "bot", botId: "bot-2", runId: "run-2" }, "Booked."),
        message({ id: "source", seq: 3, role: "user" }, "Ada, what's for lunch?"),
        message({ id: "r-4", seq: 4, role: "bot", botId: "bot-1", runId: "run-1" }, "Pasta."),
      ],
    });
    await retainRunConversation(deps, "run-1", [], { withoutReplies: true });
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Hi all.", 1),
          turn("user", "Booked.", 2, "Bea"),
          turn("user", "Ada, what's for lunch?", 3),
        ],
      }),
      expect.any(Object),
    );
  });

  it("skips a group turn whose thread was cleared", async () => {
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "gone",
      messages: [message({ id: "r-1", seq: 1, role: "bot", botId: "bot-1", runId: "run-1" }, "Hi")],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).not.toHaveBeenCalled();
  });

  it("cuts an oversized group message and keeps the newest that fit the window", async () => {
    const cut = (letter: string) => `${letter.repeat(8_000)} […]`;
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "e",
      messages: [
        ...["a", "b", "c", "d", "e"].map((letter, index) =>
          message({ id: letter, seq: index + 1, role: "user" }, letter.repeat(9_000)),
        ),
        message({ id: "r-6", seq: 6, role: "bot", botId: "bot-1", runId: "run-1" }, "Done."),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", [cut("c"), cut("d"), cut("e")].join("\n\n"), 5),
          turn("assistant", "Done.", 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("keeps what people said in a group turn with long replies, dropping the oldest replies", async () => {
    const long = (letter: string) => letter.repeat(8_000);
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "source",
      messages: [
        message({ id: "source", seq: 1, role: "user" }, "Ada, draft all five sections."),
        ...["p", "q", "r", "s", "t"].map((letter, index) =>
          message(
            { id: `r-${index + 2}`, seq: index + 2, role: "bot", botId: "bot-1", runId: "run-1" },
            long(letter),
          ),
        ),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [
          turn("user", "Ada, draft all five sections.", 1),
          turn("assistant", [long("s"), long("t")].join("\n\n"), 6),
        ],
      }),
      expect.any(Object),
    );
  });

  it("never splits a surrogate pair when cutting a group message", async () => {
    const { deps, provider } = harness({
      groupId: "group-1",
      sourceMessageId: "s",
      messages: [
        message({ id: "s", seq: 1, role: "user" }, `${"x".repeat(7_999)}😀tail`),
        message({ id: "r-2", seq: 2, role: "bot", botId: "bot-1", runId: "run-1" }, "Ok."),
      ],
    });
    await retainRunConversation(deps, "run-1");
    expect(provider.retainConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: [turn("user", `${"x".repeat(7_999)} […]`, 1), turn("assistant", "Ok.", 2)],
      }),
      expect.any(Object),
    );
  });

  it("purges the turn again when the thread was cleared during the retain", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    await retainRunConversation(deps, "run-1");
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("hands back the stored generation when the purge after a clear fails, so it runs again", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    provider.purgeHistory.mockResolvedValueOnce({ ok: false, error: "memory request failed: 503" });
    await expect(retainRunConversation(deps, "run-1")).resolves.toEqual({
      pending: { generation: 3 },
    });
  });

  it("hands back a turn still being stored without purging yet", async () => {
    const { deps, provider } = harness({ generations: [3, 4] });
    provider.retainConversation.mockResolvedValueOnce({ ok: true, value: { pending: "op-1" } });
    await expect(retainRunConversation(deps, "run-1")).resolves.toEqual({
      pending: { token: "op-1", generation: 3 },
    });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("fails the job so it retries when the provider refuses the turn", async () => {
    const { deps, provider } = harness();
    provider.retainConversation.mockResolvedValueOnce({
      ok: false,
      error: "memory request failed: 503",
    });
    await expect(retainRunConversation(deps, "run-1")).rejects.toThrow(
      "memory request failed: 503",
    );
  });
});

describe("settleRetainedConversation", () => {
  const pending = { token: "op-1", generation: 3 };

  it("keeps waiting while the provider is still storing the turn", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.retainedConversationSettled.mockResolvedValueOnce({
      ok: true,
      value: { settled: false },
    });
    await expect(settleRetainedConversation(deps, "run-1", pending)).resolves.toEqual({
      settled: false,
    });
    expect(provider.retainedConversationSettled).toHaveBeenCalledWith("op-1", expect.any(Object));
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("leaves a settled turn alone when the thread was not cleared", async () => {
    const { deps, provider } = harness({ generations: [3] });
    await expect(settleRetainedConversation(deps, "run-1", pending)).resolves.toEqual({
      settled: true,
    });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["was cleared", { generations: [4], messages: [] }],
    ["is gone", { threadGone: true, messages: [] }],
  ])("purges a settled turn whose thread %s meanwhile", async (_case, change) => {
    const { deps, provider } = harness(change);
    await settleRetainedConversation(deps, "run-1", pending);
    expect(provider.retainConversation).not.toHaveBeenCalled();
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("purges a stored turn without asking the provider when there is no token", async () => {
    const { deps, provider } = harness({ generations: [4] });
    await expect(settleRetainedConversation(deps, "run-1", { generation: 3 })).resolves.toEqual({
      settled: true,
    });
    expect(provider.retainedConversationSettled).not.toHaveBeenCalled();
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("fails the job so it retries when the purge after a clear fails", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.purgeHistory.mockResolvedValueOnce({ ok: false, error: "memory request failed: 503" });
    await expect(settleRetainedConversation(deps, "run-1", pending)).rejects.toThrow(
      "memory request failed: 503",
    );
  });
});

describe("abandonRetainedConversation", () => {
  it("purges the turn's generation once more when its chat was cleared", async () => {
    const { deps, provider } = harness({ generations: [4] });
    await abandonRetainedConversation(deps, "run-1", { generation: 3 });
    expect(provider.purgeHistory).toHaveBeenCalledWith(
      { botId: "bot-1", threadId: "thread-1", generations: [3] },
      expect.any(Object),
    );
  });

  it("leaves the turn alone when its chat was not cleared", async () => {
    const { deps, provider } = harness({ generations: [3] });
    await abandonRetainedConversation(deps, "run-1", { generation: 3 });
    expect(provider.purgeHistory).not.toHaveBeenCalled();
  });

  it("never fails: nothing checks again after giving up", async () => {
    const { deps, provider } = harness({ generations: [4] });
    provider.purgeHistory.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      abandonRetainedConversation(deps, "run-1", { generation: 3 }),
    ).resolves.toBeUndefined();
  });
});

describe("botMessageFromOutsideContent", () => {
  it("trusts a message the owner's bot sent from a clean run", async () => {
    const { prisma } = fromBea();
    expect(await botMessageFromOutsideContent(prisma as never, "inbound-1")).toBe(false);
  });

  it.each(untrustedMessages)("counts a message when %s", async (_case, change) => {
    const { prisma } = fromBea(change);
    expect(await botMessageFromOutsideContent(prisma as never, "inbound-1")).toBe(true);
  });

  it("does not count a person's message", async () => {
    const { prisma } = harness();
    expect(await botMessageFromOutsideContent(prisma as never, "message-1")).toBe(false);
  });
});

describe("history exposure", () => {
  const receiver = { spaceId: "space-1", userId: "user-1" };
  const received = {
    kind: "bot_message_received",
    fromBotId: "bot-2",
    fromBotName: "Assistant",
    text: "A learned preference",
    intent: "fyi",
  };
  const message = { role: "user", runId: null, blocks: [received] };
  const reply = { role: "bot", runId: "run-1", blocks: [{ kind: "text", text: "A reply" }] };
  function db(changes = {}) {
    return {
      bot: { findMany: vi.fn(async () => [{ id: "bot-2", ...receiver }]) },
      run: {
        findMany: vi.fn(async () => [
          {
            id: "run-1",
            status: "completed",
            readOutsideContent: false,
            bot: receiver,
            ...changes,
          },
        ]),
      },
    } as unknown as PrismaClient;
  }
  it("preserves learning from clean same-owner bots in the same Space", async () => {
    const clean = { ...message, blocks: [{ ...received, senderClean: true }] };
    expect(await historyHasOutsideContent(db(), receiver, [clean, reply])).toBe(false);
  });
  it("keeps a relayed bot message untrusted after it becomes chat history", async () => {
    expect(await historyHasOutsideContent(db(), receiver, [message])).toBe(true);
  });
  it.each([
    { readOutsideContent: true },
    { status: "running" },
    { bot: { ...receiver, spaceId: "space-2" } },
    { bot: { ...receiver, userId: "user-2" } },
  ])("does not trust reply provenance %j", async (changes) => {
    expect(await historyHasOutsideContent(db(changes), receiver, [reply])).toBe(true);
  });
  it("fails closed when provenance is missing or unavailable", async () => {
    expect(await historyHasOutsideContent(db(), receiver, [{ ...reply, runId: null }])).toBe(true);
    expect(await historyHasOutsideContent({} as PrismaClient, receiver, [reply])).toBe(true);
  });
  it("leaves ordinary human messages clean", async () => {
    expect(await historyHasOutsideContent(db(), receiver, [{ ...reply, role: "user" }])).toBe(
      false,
    );
  });
});
