import type { AdapterContext } from "@rakazo/adapter-kit";
import { MemoryDocumentLimitError, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        scope: "bot",
        botId: "bot-1",
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
  });

  it("removes one document by scope, bot and path inside the caller's space", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove(
        { id: "memory-9", scope: "bot", botId: "bot-1", path: "projects/retired.md" },
        context,
      ),
    ).resolves.toEqual({ removed: true });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "memory-9",
        spaceId: "workspace-1",
        scope: "bot",
        botId: "bot-1",
        path: "projects/retired.md",
      },
    });
  });

  it("returns false for a missing user document without touching bot memory", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const store = new MarkdownMemoryStore({ memoryDocument: { deleteMany } } as never);
    await expect(
      store.remove({ id: "missing", scope: "user", path: "projects/retired.md" }, context),
    ).resolves.toEqual({ removed: false });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "missing",
        spaceId: "workspace-1",
        scope: "user",
        botId: null,
        path: "projects/retired.md",
      },
    });
  });
});

describe("saving over a newer revision", () => {
  const store = (revision: number) => {
    const tx = { memoryDocument: { findFirst: vi.fn().mockResolvedValue({ id: "m", revision }) } };
    return new MarkdownMemoryStore({
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as never);
  };

  it("refuses with a revision conflict the caller can recognise", async () => {
    await expect(
      store(3).commit(
        { scope: "user", path: "facts.md", content: "new", expectedRevision: 2 },
        context,
      ),
    ).rejects.toBeInstanceOf(MemoryRevisionConflictError);
  });
});

describe("revision history", () => {
  it("records who wrote a revision", async () => {
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "m", revision: 1, content: "old" }),
        update: vi
          .fn()
          .mockResolvedValue({ id: "m", path: "facts.md", revision: 2, content: "new" }),
      },
      memoryRevision: { create: vi.fn().mockResolvedValue({ createdAt: new Date(0) }) },
    };
    const store = new MarkdownMemoryStore({
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as never);
    await expect(
      store.commit(
        { scope: "bot", botId: "bot-1", path: "facts.md", content: "new", sourceKind: "dream" },
        context,
      ),
    ).resolves.toEqual({
      id: "m",
      path: "facts.md",
      revision: 2,
      content: "new",
      sourceKind: "dream",
      createdAt: new Date(0).toISOString(),
    });
    expect(tx.memoryRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sourceKind: "dream" }),
    });
  });

  it("lists a document's history newest first", async () => {
    const createdAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      { id: "r2", revision: 2, sourceKind: "bot", createdAt },
      { id: "r1", revision: 1, sourceKind: null, createdAt },
    ]);
    const store = new MarkdownMemoryStore({ memoryRevision: { findMany } } as never);
    await expect(store.listRevisions({ documentId: "m", limit: 5 }, context)).resolves.toEqual([
      { id: "r2", revision: 2, sourceKind: "bot", createdAt: createdAt.toISOString() },
      { id: "r1", revision: 1, sourceKind: "user", createdAt: createdAt.toISOString() },
    ]);
  });

  it("reads one revision inside the caller's space", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "r1",
      revision: 1,
      content: "old",
      sourceKind: "undo",
      createdAt: new Date("2026-08-16T10:00:00.000Z"),
      document: { path: "facts.md" },
    });
    const store = new MarkdownMemoryStore({ memoryRevision: { findFirst } } as never);
    await expect(
      store.readRevision({ documentId: "m", revisionId: "r1" }, context),
    ).resolves.toEqual({
      id: "r1",
      path: "facts.md",
      revision: 1,
      content: "old",
      sourceKind: "undo",
      createdAt: "2026-08-16T10:00:00.000Z",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1", documentId: "m", document: { spaceId: "workspace-1" } },
      }),
    );
  });
});

describe("bank size and descriptions", () => {
  const store = (tx: unknown) =>
    new MarkdownMemoryStore({
      $transaction: vi.fn(async (fn: (client: never) => unknown) => fn(tx as never)),
    } as never);

  it("refuses a new path once the bank is full", async () => {
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(20),
      },
      memoryRevision: { create: vi.fn() },
    };
    await expect(
      store(tx).commit({ scope: "user", path: "new.md", content: "x" }, context),
    ).rejects.toBeInstanceOf(MemoryDocumentLimitError);
    expect(tx.memoryRevision.create).not.toHaveBeenCalled();
  });

  it("overwrites an existing path even when the bank is full", async () => {
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "m", revision: 1 }),
        update: vi.fn().mockResolvedValue({ id: "m", path: "MEMORY.md", revision: 2 }),
        count: vi.fn(),
      },
      memoryRevision: { create: vi.fn().mockResolvedValue({ createdAt: new Date(0) }) },
    };
    await expect(
      store(tx).commit({ scope: "user", path: "MEMORY.md", content: "x" }, context),
    ).resolves.toMatchObject({ revision: 2 });
    expect(tx.memoryDocument.count).not.toHaveBeenCalled();
  });

  it("writes a description and keeps it when the caller leaves it out", async () => {
    const update = vi.fn().mockResolvedValue({ id: "m", path: "MEMORY.md", revision: 2 });
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "m", revision: 1 }),
        update,
        count: vi.fn(),
      },
      memoryRevision: { create: vi.fn().mockResolvedValue({ createdAt: new Date(0) }) },
    };
    await store(tx).commit(
      { scope: "user", path: "MEMORY.md", content: "x", description: "Who we are" },
      context,
    );
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "m" },
      data: { content: "x", revision: 2, description: "Who we are" },
    });
    await store(tx).commit({ scope: "user", path: "MEMORY.md", content: "y" }, context);
    expect(update).toHaveBeenLastCalledWith({
      where: { id: "m" },
      data: { content: "y", revision: 2 },
    });
  });
});
