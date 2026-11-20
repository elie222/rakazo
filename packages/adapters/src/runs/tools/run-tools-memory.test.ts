import { MEMORY_REVISION_CONFLICT_ERROR, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "@rakazo/contracts";
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
      bot: { useSharedMemory: true },
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

  it("refuses to write shared notes when the bot turned them off", async () => {
    const memory = { read: vi.fn(), commit: vi.fn() };
    const result = await memoryTools.save_shared_memory!(
      { runId: "run-1", bot: { useSharedMemory: false }, deps: { memory } } as never,
      {
        args: { path: "team.md", content: "new" },
        finish: async (value: unknown) => value,
      } as never,
    );
    expect(result).toEqual({ error: "Shared memory is turned off for this bot in its settings." });
    expect(memory.commit).not.toHaveBeenCalled();
  });

  it("refuses to write its own notes when the bot turned them off", async () => {
    const memory = { read: vi.fn(), commit: vi.fn() };
    const result = await memoryTools.remember!(
      {
        runId: "run-1",
        bot: { id: "bot-1", useOwnMemory: false },
        thread: { id: "thread-1" },
        deps: { memory },
      } as never,
      { args: { content: "fact" }, finish: async (value: unknown) => value } as never,
    );
    expect(result).toEqual({ error: "This bot's own memory is turned off in its settings." });
    expect(memory.commit).not.toHaveBeenCalled();
  });
});
