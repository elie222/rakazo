import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { contentEncryptionOf, withContentEncryption } from "./content-encryption.js";
import type { SpaceKeyStore } from "./content-keys.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";

// No query reaches the database: every case fails before the driver is used.
const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
const unreachable = () => Promise.reject(new Error("unexpected key store access"));
const store: SpaceKeyStore = {
  forSpace: unreachable,
  byId: unreachable,
  insert: unreachable,
  rowContext: unreachable,
  sampleByMasterKey: unreachable,
};
const ring = new ContentKeyRing(new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]), store);
const prisma = withContentEncryption(new PrismaClient({ adapter: new PrismaPg(pool) }), ring);

afterAll(async () => {
  await pool.end();
});

describe("withContentEncryption", () => {
  it("exposes its key ring to raw-SQL readers and nothing to plain clients", () => {
    expect(contentEncryptionOf(prisma)?.ring).toBe(ring);
    expect(contentEncryptionOf({})).toBeUndefined();
  });

  it("rejects nested writes that would bypass encryption", async () => {
    await expect(
      prisma.thread.create({
        data: {
          spaceId: "s",
          userId: "u",
          messages: { create: { seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] } },
        },
      }),
    ).rejects.toThrow(/nested write/);
    await expect(
      prisma.thread.create({
        data: {
          spaceId: "s",
          userId: "u",
          messages: {
            createMany: { data: [{ seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] }] },
          },
        },
      }),
    ).rejects.toThrow(/nested write/);
    await expect(
      prisma.memoryDocument.update({
        where: { id: "doc" },
        data: { revisions: { create: { revision: 2, content: "x" } } },
      }),
    ).rejects.toThrow(/nested write/);
  });

  it("requires encrypted updates to name one row by id", async () => {
    await expect(
      prisma.message.updateMany({ where: { threadId: "t" }, data: { blocks: [] } }),
    ).rejects.toThrow(/updated by id/);
    await expect(
      prisma.memoryDocument.upsert({
        where: { id: "doc" },
        create: { spaceId: "s", userId: "u", scope: "user", path: "p", content: "x" },
        update: { content: "x" },
      }),
    ).rejects.toThrow(/Upserts/);
  });

  it("requires creates to name their owner", async () => {
    await expect(
      prisma.memoryRevision.create({ data: { revision: 1, content: "x" } as never }),
    ).rejects.toThrow(/documentId/);
  });
});
