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

describe("deleting a shared memory document", () => {
  const del = (path: string, documents: Array<{ id: string; path: string }>, removed = true) => {
    const memory = {
      read: vi.fn(async () => ({ documents })),
      remove: vi.fn(async () => ({ removed })),
    };
    const ctx = { context: { spaceId: "space-1" }, deps: { memory } };
    const result = memoryTools.delete_shared_memory!(
      ctx as never,
      { args: { path }, finish: (value: unknown) => value } as never,
    );
    return { memory, result };
  };

  it("removes exactly the document it read", async () => {
    const { memory, result } = del(" team.md ", [{ id: "doc-1", path: "team.md" }]);
    await expect(result).resolves.toEqual({ ok: true, path: "team.md" });
    expect(memory.read).toHaveBeenCalledWith(
      { scope: "user", path: "team.md" },
      { spaceId: "space-1" },
    );
    expect(memory.remove).toHaveBeenCalledWith(
      { id: "doc-1", scope: "user", path: "team.md" },
      { spaceId: "space-1" },
    );
  });

  it("keeps the index document, which is edited instead", async () => {
    const { memory, result } = del("MEMORY.md", [{ id: "doc-1", path: "MEMORY.md" }]);
    await expect(result).resolves.toEqual({
      error: "MEMORY.md cannot be deleted; edit its content instead.",
    });
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("says when no document has that name", async () => {
    const { memory, result } = del("gone.md", []);
    await expect(result).resolves.toEqual({ error: "No shared memory document named gone.md." });
    expect(memory.remove).not.toHaveBeenCalled();
  });

  it("says when the document was deleted before it was removed", async () => {
    const { result } = del("team.md", [{ id: "doc-1", path: "team.md" }], false);
    await expect(result).resolves.toEqual({
      error: "team.md was already deleted.",
    });
  });
});
