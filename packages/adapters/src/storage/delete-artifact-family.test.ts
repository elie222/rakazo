import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { deleteArtifactFamilyRows } from "./delete-artifact-family.js";

type Member = {
  id: string;
  storageKey: string;
  createdAt?: Date;
  botId?: string | null;
  name?: string;
};
const context = { spaceId: "space-1", operationId: "op-1" } as unknown as AdapterContext;

function client(listings: Member[][], rootLocked = true) {
  const calls: string[] = [];
  const queries: string[] = [];
  let read = 0;
  const prisma = {
    artifact: {
      findMany: vi.fn(async () => listings[Math.min(read++, listings.length - 1)] ?? []),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push(`delete:${where.id}`);
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => {
      await run({
        $queryRaw: vi.fn(async (query: { sql: string }) => {
          queries.push(query.sql);
          return rootLocked ? [{ id: "root" }] : [];
        }),
        artifact: {
          findFirst: vi.fn(async () => null),
          delete: vi.fn(async ({ where }: { where: { id: string } }) => {
            calls.push(`delete:${where.id}`);
          }),
        },
      });
    }),
  };
  return { calls, queries, prisma: prisma as unknown as PrismaClient };
}

const root = { id: "root", storageKey: "blob-root" };
const v2 = { id: "v2", storageKey: "blob-v2" };
const v3 = { id: "v3", storageKey: "blob-v3" };

describe("deleteArtifactFamilyRows", () => {
  it("removes every blob before its row, versions before the root", async () => {
    const db = client([[root, v2, v3], [root, v3], [root], []]);
    const remove = vi.fn(async (key: string) => {
      db.calls.push(`remove:${key}`);
    });

    await expect(
      deleteArtifactFamilyRows(
        { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context },
      ),
    ).resolves.toBe("deleted");

    expect(db.calls).toEqual([
      "remove:blob-v2",
      "delete:v2",
      "remove:blob-v3",
      "delete:v3",
      "remove:blob-root",
      "delete:root",
    ]);
    expect(remove).toHaveBeenCalledWith("blob-root", context);
  });

  it("still deletes the row when the blob is already gone", async () => {
    const db = client([[root]]);
    const remove = vi.fn(async (key: string) => {
      db.calls.push(`remove:${key}`);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    await expect(
      deleteArtifactFamilyRows(
        { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context },
      ),
    ).resolves.toBe("deleted");
    expect(db.calls).toEqual(["remove:blob-root", "delete:root"]);
  });

  it("says gone when the root was deleted concurrently", async () => {
    const db = client([[root]], false);
    const remove = vi.fn(async () => undefined);

    await expect(
      deleteArtifactFamilyRows(
        { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context },
      ),
    ).resolves.toBe("gone");
    expect(remove).not.toHaveBeenCalled();

    const empty = client([[]]);
    await expect(
      deleteArtifactFamilyRows(
        { prisma: empty.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context },
      ),
    ).resolves.toBe("gone");
  });

  it("keeps the family once a member is as new as the cutoff, after the versions already gone", async () => {
    const cutoff = new Date("2026-10-18T00:00:00Z");
    const old = new Date("2026-09-01T00:00:00Z");
    const published = { id: "v4", storageKey: "blob-v4", createdAt: cutoff };
    const db = client([
      [
        { ...root, createdAt: old },
        { ...v2, createdAt: old },
      ],
      [{ ...root, createdAt: old }, published],
    ]);
    const remove = vi.fn(async (key: string) => {
      db.calls.push(`remove:${key}`);
    });

    await expect(
      deleteArtifactFamilyRows(
        { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context, onlyOlderThan: cutoff },
      ),
    ).resolves.toBe("kept");
    expect(db.calls).toEqual(["remove:blob-v2", "delete:v2"]);
  });

  it("deletes a family with a new member when no cutoff is given", async () => {
    const db = client([[root, { ...v2, createdAt: new Date() }], [root]]);
    const remove = vi.fn(async () => undefined);

    await expect(
      deleteArtifactFamilyRows(
        { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
        { spaceId: "space-1", rootId: "root", context },
      ),
    ).resolves.toBe("deleted");
    expect(db.calls).toEqual(["delete:v2", "delete:root"]);
  });

  it("takes the same-name publish lock before locking a bot's root", async () => {
    const db = client([[{ ...root, botId: "bot-1", name: "report.pdf" }]]);
    const remove = vi.fn(async () => undefined);

    await deleteArtifactFamilyRows(
      { prisma: db.prisma, artifacts: { remove } as unknown as ArtifactStore },
      { spaceId: "space-1", rootId: "root", context },
    );
    expect(db.queries[0]).toContain("pg_advisory_xact_lock");
    expect(db.queries[1]).toContain("FOR UPDATE");

    const withoutBot = client([[root]]);
    await deleteArtifactFamilyRows(
      { prisma: withoutBot.prisma, artifacts: { remove } as unknown as ArtifactStore },
      { spaceId: "space-1", rootId: "root", context },
    );
    expect(withoutBot.queries).toHaveLength(1);
    expect(withoutBot.queries[0]).toContain("FOR UPDATE");
  });
});
