import type { AdapterContext } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
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
  it("rejects a replacement document even when its revision matches", async () => {
    const tx = {
      memoryDocument: { findFirst: vi.fn().mockResolvedValue({ id: "new-document", revision: 1 }) },
      memoryRevision: { createMany: vi.fn() },
    };
    const store = new MarkdownMemoryStore({
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    } as never);
    await expect(
      store.commit(
        {
          scope: "bot",
          botId: "bot-1",
          path: "MEMORY.md",
          content: "new",
          expectedRevision: 1,
          expectedDocumentId: "old-document",
        },
        context,
      ),
    ).rejects.toThrow(MEMORY_REVISION_CONFLICT_ERROR);
    expect(tx.memoryRevision.createMany).not.toHaveBeenCalled();
  });
  it("records the original revision before replacing a seeded document", async () => {
    const existing = { id: "memory-1", path: "MEMORY.md", revision: 1, content: "old" };
    const revisions = { createMany: vi.fn(), create: vi.fn() };
    const tx = {
      memoryDocument: {
        findFirst: vi.fn().mockResolvedValue(existing),
        update: vi.fn().mockResolvedValue({ ...existing, revision: 2, content: "new" }),
      },
      memoryRevision: revisions,
    };
    const store = new MarkdownMemoryStore({
      $transaction: (run: (client: typeof tx) => unknown) => run(tx),
    } as never);
    await store.commit(
      { scope: "bot", botId: "bot-1", path: "MEMORY.md", content: "new", expectedRevision: 1 },
      context,
    );
    expect(revisions.createMany).toHaveBeenCalledWith({
      data: [{ documentId: "memory-1", revision: 1, content: "old" }],
      skipDuplicates: true,
    });
  });
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
        userId: "user-1",
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
        userId: "user-1",
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
        userId: "user-1",
        scope: "user",
        botId: null,
        path: "projects/retired.md",
      },
    });
  });
});
