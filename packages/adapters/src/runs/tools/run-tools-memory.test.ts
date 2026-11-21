import { MEMORY_REVISION_CONFLICT_ERROR, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { memoryTools, withoutBlankFields } from "./run-tools-memory.js";

const readHistory = vi.hoisted(() =>
  vi.fn(async () => ({ untrusted: true, messages: [], runs: [], snapshots: [] })),
);
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readHistory,
}));

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

describe("read_history tool details", () => {
  const LINKED_RUN = "cmw3l7emsa1sfb5bml8d0doe0";
  const ctx = (source: Record<string, unknown>, userId: string | null) => ({
    deps: { prisma: {} },
    run: { id: "run-2", spaceId: "space-1", threadId: "thread-1", botId: "bot-1", userId },
    source: { toolDetailsAllowed: true, myChatsAllowed: false, ...source },
    trust: { receivedOutsideMessage: async () => false },
    computer: { copyEarlierFiles: () => undefined },
    secrets: [],
  });
  const readLinked = (run: unknown) =>
    memoryTools.read_history!(
      run as never,
      {
        name: "read_history",
        args: { messageId: LINKED_RUN, linkedRunId: LINKED_RUN },
        finish: (value: unknown) => value,
      } as never,
    );

  it("names the reader in the scope, where the database reads it", async () => {
    await readLinked(ctx({}, "user-1"));
    expect(readHistory).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ toolDetailsUserId: "user-1" }),
      expect.objectContaining({ linkedRunId: LINKED_RUN }),
    );
  });

  it.each([
    ["the source forbids tool details", ctx({ toolDetailsAllowed: false }, "user-1")],
    ["the run has no starter", ctx({}, null)],
  ])("names no reader when %s", async (_case, run) => {
    await readLinked(run);
    expect(readHistory).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ toolDetailsUserId: expect.anything() }),
      expect.anything(),
    );
  });
});

it.each(["isolated", "shared"])(
  "applies outside-input protections to explicit recall in %s scope",
  async (scope) => {
    const response = { ok: true, value: [{ memory: "A shared preference", score: 1 }] };
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { historyCompactedUpToSeq: null },
      context: {},
      state: { tainted: false },
      memory: { scope, semantic: { recall: vi.fn(async () => response) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    expect(
      await memoryTools.recall_memory!(ctx as never, { args: { query: "preference" } } as never),
    ).toEqual(response);
    expect(ctx.state.tainted).toBe(true);
  },
);

it.each(["Provider-generated context", ""])(
  "records reflection exposure only for a nonempty answer: %j",
  async (text) => {
    const ctx = {
      runId: "run-1",
      bot: { id: "bot-1" },
      context: {},
      state: { tainted: false },
      memory: { semantic: { reflect: vi.fn(async () => ({ ok: true, value: text })) } },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
    expect(ctx.state.tainted).toBe(Boolean(text));
  },
);

describe("saving shared memory over a newer revision", () => {
  const save = (failure: Error) => {
    const finish = vi.fn((result: unknown) => result);
    const ctx = {
      runId: "run-1",
      thread: { id: "thread-1" },
      context: {},
      deps: {
        memory: {
          read: vi.fn(async () => ({ documents: [{ revision: 1 }] })),
          commit: vi.fn().mockRejectedValue(failure),
        },
      },
    };
    return memoryTools.save_shared_memory!(
      ctx as never,
      { args: { path: "team.md", content: "new" }, finish } as never,
    );
  };

  it("tells the bot to read again", async () => {
    await expect(save(new MemoryRevisionConflictError())).resolves.toEqual({
      error: MEMORY_REVISION_CONFLICT_ERROR,
    });
  });

  it("lets another failure through, even one quoting the conflict", async () => {
    const failure = new Error(MEMORY_REVISION_CONFLICT_ERROR);
    await expect(save(failure)).rejects.toBe(failure);
  });
});
