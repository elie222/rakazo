import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { ArtifactListCursorError, deleteArtifactFamily, listSpaceArtifacts } from "./artifacts.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

function listRow(id: string, familyId: string, createdAt = "2026-09-01T00:00:00.000Z") {
  return {
    id,
    familyId,
    botId: "bot-1",
    groupId: null,
    runId: null,
    name: familyId,
    description: null,
    mimeType: "text/markdown",
    size: 12,
    version: 1,
    createdAt: new Date(createdAt),
    versionCount: 1,
  };
}

function cursor(input: { createdAt: string; id: string; botId: string | null; asOf?: string }) {
  return `v1.${Buffer.from(
    JSON.stringify({
      createdAt: input.createdAt,
      id: input.id,
      botId: input.botId,
      asOf: input.asOf ?? "2026-09-20T00:00:00.000Z",
    }),
    "utf8",
  ).toString("base64url")}`;
}

function statement(query: { strings: string[] }) {
  return query.strings.join(" ");
}

function scopedClause(query: { strings: string[] }) {
  const text = statement(query);
  return text.slice(text.indexOf("WITH scoped"), text.indexOf("latest AS"));
}

describe("listSpaceArtifacts", () => {
  it("pages families in the database instead of slicing a fixed newest-row snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      const queryRaw = vi
        .fn()
        .mockResolvedValue([
          listRow("version-a", "family-a"),
          listRow("version-b", "family-b"),
          listRow("version-c", "family-c"),
        ]);
      const page = await listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        { limit: 2 },
      );

      const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
      const text = statement(sql);
      expect(text).toContain("DISTINCT ON");
      expect(text).toContain("LIMIT");
      expect(text).not.toMatch(/\b500\b/);
      expect(scopedClause(sql)).toContain('"createdAt" <=');
      expect(sql.values).toContain(3);
      expect(sql.values).toContainEqual(new Date("2026-09-20T12:00:00.000Z"));
      expect(page.items.map((item) => item.id)).toEqual(["family-a", "family-b"]);
      expect(page.nextCursor).toBe(
        cursor({
          createdAt: "2026-09-01T00:00:00.000Z",
          id: "version-b",
          botId: null,
          asOf: "2026-09-20T12:00:00.000Z",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unseen family on a later page when it gains a version after page one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
    try {
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce([
          listRow("version-a", "family-a", "2026-09-03T00:00:00.000Z"),
          listRow("version-b", "family-b", "2026-09-02T00:00:00.000Z"),
          listRow("version-c", "family-c", "2026-09-01T00:00:00.000Z"),
        ])
        .mockResolvedValueOnce([listRow("version-c", "family-c", "2026-09-01T00:00:00.000Z")]);
      const deps = {
        prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      };
      const first = await listSpaceArtifacts(deps, actor, { limit: 2 });
      vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
      const second = await listSpaceArtifacts(deps, actor, {
        cursor: first.nextCursor ?? undefined,
        limit: 2,
      });

      const continuation = queryRaw.mock.calls[1]?.[0] as { strings: string[]; values: unknown[] };
      expect(scopedClause(continuation)).toContain('"createdAt" <=');
      expect(continuation.values).toContainEqual(new Date("2026-09-20T12:00:00.000Z"));
      expect(continuation.values).not.toContainEqual(new Date("2026-09-21T12:00:00.000Z"));
      expect(continuation.values).toContain("version-b");
      expect(second.items.map((item) => item.id)).toEqual(["family-c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a cursor that has no version snapshot", async () => {
    const legacy = `v1.${Buffer.from(
      JSON.stringify({
        createdAt: "2026-08-01T00:00:00.000Z",
        id: "version-b",
        botId: null,
      }),
      "utf8",
    ).toString("base64url")}`;
    const queryRaw = vi.fn();
    await expect(
      listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        { cursor: legacy, limit: 2 },
      ),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("keeps paging from a cursor whose row was deleted", async () => {
    const pageCursor = cursor({
      createdAt: "2026-08-01T00:00:00.000Z",
      id: "version-b",
      botId: null,
    });
    const findFirst = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([]);
    await listSpaceArtifacts(
      {
        prisma: { artifact: { findFirst }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      },
      actor,
      { cursor: pageCursor, limit: 2 },
    );

    expect(findFirst).not.toHaveBeenCalled();
    const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    expect(statement(sql)).toContain('latest."createdAt", latest.id');
    expect(scopedClause(sql)).toContain('"createdAt" <=');
    expect(sql.values).toContainEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(sql.values).toContainEqual(new Date("2026-09-20T00:00:00.000Z"));
    expect(sql.values).toContain("version-b");
  });

  it("rejects a cursor from a different bot filter instead of replaying the first page", async () => {
    const queryRaw = vi.fn();
    await expect(
      listSpaceArtifacts(
        {
          prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
            PrismaClient,
            "artifact" | "$queryRaw"
          >,
        },
        actor,
        {
          botId: "bot-2",
          cursor: cursor({
            createdAt: "2026-08-01T00:00:00.000Z",
            id: "version-b",
            botId: "bot-1",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ArtifactListCursorError);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("applies a bot-scoped cursor with that bot filter", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const pageCursor = cursor({
      createdAt: "2026-08-01T00:00:00.000Z",
      id: "version-b",
      botId: "bot-1",
    });
    await listSpaceArtifacts(
      {
        prisma: { artifact: { findFirst: vi.fn() }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      },
      actor,
      { botId: "bot-1", cursor: pageCursor, limit: 2 },
    );

    const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    const text = sql.strings.join(" ");
    expect(text).toContain('"botId"');
    expect(text).not.toContain('"botId" IS NULL');
    expect(sql.values).toContain("bot-1");
    expect(sql.values).toContain("version-b");
  });
});

describe("deleteArtifactFamily", () => {
  function familyClient(listings: Array<Array<{ id: string; storageKey: string; botId: string }>>) {
    const calls: string[] = [];
    let read = 0;
    let rootChecks = 0;
    const deferRootDeletes = { count: 0 };
    const prisma = {
      artifact: {
        findFirst: vi.fn(async () => ({ id: "root", rootArtifactId: null, botId: "bot-1" })),
        findMany: vi.fn(async () => {
          const page = listings[Math.min(read, listings.length - 1)] ?? [];
          read += 1;
          return page;
        }),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          calls.push(`delete:${where.id}`);
        }),
      },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => {
        await run({
          $queryRaw: vi.fn(async () => [{ id: "root" }]),
          artifact: {
            findFirst: vi.fn(async () => {
              rootChecks += 1;
              return rootChecks <= deferRootDeletes.count ? { id: "v2" } : null;
            }),
            delete: vi.fn(async ({ where }: { where: { id: string } }) => {
              calls.push(`delete:${where.id}`);
            }),
          },
        });
      }),
    };
    return { calls, deferRootDeletes, prisma: prisma as unknown as PrismaClient };
  }

  it("removes each blob before its row and versions before the root", async () => {
    const client = familyClient([
      [
        { id: "root", storageKey: "blob-root", botId: "bot-1" },
        { id: "v2", storageKey: "blob-v2", botId: "bot-1" },
      ],
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [],
    ]);
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(client.calls).toEqual([
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-root",
      "delete:root",
    ]);
  });

  it("leaves the row in place when blob removal fails", async () => {
    const client = familyClient([[{ id: "root", storageKey: "blob-root", botId: "bot-1" }]]);
    const remove = vi.fn(async () => {
      throw new Error("storage down");
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).rejects.toThrow("storage down");
    expect(client.calls).toEqual([]);
  });

  it("does not remove the root blob when a version appears before the root is deleted", async () => {
    const client = familyClient([
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [
        { id: "root", storageKey: "blob-root", botId: "bot-1" },
        { id: "v2", storageKey: "blob-v2", botId: "bot-1" },
      ],
      [{ id: "root", storageKey: "blob-root", botId: "bot-1" }],
      [],
    ]);
    client.deferRootDeletes.count = 1;
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
    });

    await deleteArtifactFamily(
      {
        prisma: client.prisma,
        artifacts: { remove } as unknown as ArtifactStore,
      },
      actor,
      { familyId: "root" },
    );

    expect(client.calls).toEqual([
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-root",
      "delete:root",
    ]);
  });

  it("finishes a retry when the blob was already removed", async () => {
    const client = familyClient([[{ id: "root", storageKey: "blob-root", botId: "bot-1" }]]);
    const remove = vi.fn(async (id: string) => {
      client.calls.push(`remove:${id}`);
      const missing = new Error("missing");
      Object.assign(missing, { code: "ENOENT" });
      throw missing;
    });

    await expect(
      deleteArtifactFamily(
        {
          prisma: client.prisma,
          artifacts: { remove } as unknown as ArtifactStore,
        },
        actor,
        { familyId: "root" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(client.calls).toEqual(["remove:blob-root", "delete:root"]);
  });
});
