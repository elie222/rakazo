import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { deleteArtifactFamily, listSpaceArtifacts } from "./artifacts.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

function listRow(id: string, familyId: string) {
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
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    versionCount: 1,
  };
}

describe("listSpaceArtifacts", () => {
  it("pages families in the database instead of slicing a fixed newest-row snapshot", async () => {
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
    const text = sql.strings.join(" ");
    expect(text).toContain("DISTINCT ON");
    expect(text).toContain("LIMIT");
    expect(text).not.toMatch(/\b500\b/);
    expect(sql.values).toContain(3);
    expect(page.items.map((item) => item.id)).toEqual(["family-a", "family-b"]);
    expect(page.nextCursor).toBe("version-b");
  });

  it("applies a keyset cursor from a caller-owned row", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const findFirst = vi.fn().mockResolvedValue({ createdAt });
    const queryRaw = vi.fn().mockResolvedValue([]);
    await listSpaceArtifacts(
      {
        prisma: { artifact: { findFirst }, $queryRaw: queryRaw } as unknown as Pick<
          PrismaClient,
          "artifact" | "$queryRaw"
        >,
      },
      actor,
      { cursor: "version-b", limit: 2 },
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "version-b", spaceId: "space-1", userId: "user-1" },
      select: { createdAt: true },
    });
    const sql = queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join(" ")).toContain('latest."createdAt", latest.id');
    expect(sql.values).toContain(createdAt);
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

  it("does not drop a version published before the root row is deleted", async () => {
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
      "remove:blob-root",
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-root",
      "delete:root",
    ]);
  });
});
