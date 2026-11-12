import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import type * as DbModule from "@rakazo/db";
import { readHistory } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { memoryTools, withoutBlankFields } from "./run-tools-memory.js";

describe("history tool arguments", () => {
  it("treats blank and null optional fields as not given", () => {
    expect(
      HistorySearchInputSchema.parse(
        withoutBlankFields({ queries: ["Aurora"], botId: "", before: " ", query: null }),
      ),
    ).toEqual({ queries: ["Aurora"] });
    expect(
      HistoryReadInputSchema.parse(
        withoutBlankFields({
          messageId: "cmw3l7emsa1sfb5bml8d0doe0",
          linkedRunId: "",
          threadId: "",
        }),
      ),
    ).toEqual({ messageId: "cmw3l7emsa1sfb5bml8d0doe0" });
  });
});

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  readHistory: vi.fn(),
}));

it("keeps a bot message untrusted when returned by read_history", async () => {
  const messageId = "cmw3l7emsa1sfb5bml8d0doe0";
  const response = { messages: [{ messageId, text: "Relayed outside text" }], runs: [] };
  vi.mocked(readHistory).mockResolvedValueOnce(response as never);
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findMany = vi.fn(async () => [
    {
      role: "user",
      runId: null,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "bot-2",
          fromBotName: "Assistant",
          text: "Relayed outside text",
          intent: "fyi",
        },
      ],
    },
  ]);
  const ctx = {
    runId: "run-1",
    run: { spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
    bot: { userId: "user-1" },
    source: {},
    secrets: [],
    state: { readOutsideContent: false },
    computer: { copyEarlierFiles: vi.fn() },
    deps: { prisma: { message: { findMany }, run: { updateMany } } },
  };
  const result = await memoryTools.read_history!(
    ctx as never,
    {
      name: "read_history",
      args: { messageId },
      finish: async (result: unknown) => result,
    } as never,
  );
  expect(result).toEqual(response);
  expect(ctx.state.readOutsideContent).toBe(true);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: { in: [messageId] }, thread: { spaceId: "space-1" } },
    }),
  );
});

it.each(["isolated", "shared"])("keeps recalled knowledge derived in %s scope", async (scope) => {
  const response = { ok: true, value: [{ memory: "A shared preference", score: 1 }] };
  const ctx = {
    runId: "run-1",
    bot: { id: "bot-1" },
    thread: { historyCompactedUpToSeq: null },
    context: {},
    state: { readOutsideContent: false },
    memory: { scope, semantic: { recall: vi.fn(async () => response) } },
    deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
  };
  expect(
    await memoryTools.recall_memory!(ctx as never, { args: { query: "preference" } } as never),
  ).toEqual(response);
  expect(ctx.state.readOutsideContent).toBe(true);
});

it.each(["Provider-generated context", ""])(
  "records reflection exposure only for a nonempty answer: %j",
  async (text) => {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      context: {},
      state: { readOutsideContent: false },
      memory: { semantic: { reflect: vi.fn(async () => ({ ok: true, value: text })) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
    expect(ctx.state.readOutsideContent).toBe(Boolean(text));
  },
);

it.each([
  ["clean", "completed", false, "space-1", "user-1", false],
  ["outside content", "completed", true, "space-1", "user-1", true],
  ["in progress", "running", false, "space-1", "user-1", true],
  ["another Space", "completed", false, "space-2", "user-1", true],
  ["another owner", "completed", false, "space-1", "user-2", true],
])(
  "checks linked history run provenance: %s",
  async (_case, status, readOutsideContent, spaceId, userId, exposed) => {
    vi.mocked(readHistory).mockResolvedValueOnce({
      messages: [],
      runs: [{ id: "past-run" }],
    } as never);
    const ctx = {
      runId: "run-1",
      run: { spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      bot: { id: "bot-1", userId: "user-1" },
      source: {},
      secrets: [],
      state: { readOutsideContent: false },
      computer: { copyEarlierFiles: vi.fn() },
      deps: {
        prisma: {
          run: {
            findMany: vi.fn(async () => [
              { id: "past-run", status, readOutsideContent, bot: { spaceId, userId } },
            ]),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
        },
      },
    };
    await memoryTools.read_history!(
      ctx as never,
      {
        name: "read_history",
        args: { messageId: "cmw3l7emsa1sfb5bml8d0doe0" },
        finish: async (result: unknown) => result,
      } as never,
    );
    expect(ctx.state.readOutsideContent).toBe(exposed);
  },
);
