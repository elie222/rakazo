import { MemoryRevisionConflictError } from "@rakazo/adapter-kit";
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
      memory: {
        scope: "isolated",
        semantic: { reflect: vi.fn(async () => ({ ok: true, value: text })) },
      },
      deps: { prisma: { run: { updateMany: vi.fn(async () => ({ count: 1 })) } } },
    };
    await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
    expect(ctx.state.tainted).toBe(Boolean(text));
  },
);

it("passes the bot's memory scope to the reflect provider", async () => {
  const reflect = vi.fn(async () => ({ ok: true, value: "" }));
  const ctx = {
    bot: { id: "bot-1" },
    context: {},
    memory: { scope: "shared", semantic: { reflect } },
  };
  await memoryTools.reflect_memory!(ctx as never, { args: { query: "Question" } } as never);
  expect(reflect).toHaveBeenCalledWith(
    { query: "Question", botId: "bot-1", scope: "shared" },
    ctx.context,
  );
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

describe("remembering in another private memory document", () => {
  const remember = (args: Record<string, unknown>, documents: unknown[]) => {
    const memory = {
      read: vi.fn(async () => ({ documents })),
      commit: vi.fn(async () => ({})),
    };
    const ctx = {
      runId: "run-1",
      run: { userId: "user-1" },
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context: {},
      deps: {
        memory,
        now: () => new Date("2026-03-05T23:30:00Z"),
        prisma: { user: { findUnique: async () => ({ timezone: "Pacific/Auckland" }) } },
      },
    };
    const result = memoryTools.remember!(
      ctx as never,
      { args, finish: (value: unknown) => value } as never,
    );
    return { memory, result };
  };

  it("edits one entry and leaves the rest of the document", async () => {
    const { memory, result } = remember(
      {
        path: "USER.md",
        operations: [
          { action: "replace", old_text: "Lives in Paris", content: "- Lives in Berlin" },
        ],
      },
      [{ path: "USER.md", content: "# User\n- Lives in Paris\n- Likes tea\n", revision: 3 }],
    );
    await expect(result).resolves.toEqual({ ok: true });
    expect(memory.read).toHaveBeenCalledWith({ scope: "bot", botId: "bot-1", path: "USER.md" }, {});
    expect(memory.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "USER.md",
        content: "# User\n- Lives in Berlin (saved 2026-03-06)\n- Likes tea\n",
        expectedRevision: 3,
      }),
      {},
    );
  });

  it("edits the Space's shared memory again after a concurrent save", async () => {
    const { memory, result } = remember(
      { shared: true, operations: [{ action: "add", content: "Invoices go to Dana." }] },
      [{ path: "MEMORY.md", content: "# Team\n", revision: 2 }],
    );
    memory.commit.mockRejectedValueOnce(new MemoryRevisionConflictError());
    await expect(result).resolves.toEqual({ ok: true });
    expect(memory.read).toHaveBeenCalledWith({ scope: "user", path: "MEMORY.md" }, {});
    expect(memory.commit).toHaveBeenCalledTimes(2);
    expect(memory.commit).toHaveBeenLastCalledWith(
      {
        scope: "user",
        path: "MEMORY.md",
        content: "# Team\nInvoices go to Dana. (saved 2026-03-06)\n",
        expectedRevision: 2,
        sourceRunId: "run-1",
        sourceThreadId: "thread-1",
      },
      {},
    );
  });

  it("stamps a temporary entry with its end", async () => {
    const { memory, result } = remember(
      {
        operations: [
          { action: "add", content: "No visits to the flat.", until: "2026-03-19" },
          {
            action: "add",
            content: "Quote 7 days for delivery.",
            until: "the courier backlog clears",
          },
        ],
      },
      [{ path: "MEMORY.md", content: "", revision: 1 }],
    );
    await expect(result).resolves.toEqual({ ok: true });
    expect(memory.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "No visits to the flat. (saved 2026-03-06, ends 2026-03-19)\nQuote 7 days for delivery. (saved 2026-03-06, ends when the courier backlog clears)\n",
      }),
      {},
    );
  });
});
