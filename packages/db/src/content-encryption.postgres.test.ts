import { randomBytes } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { ContentDecryptionError } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { LocalKeyProvider, masterKeysFromEnv } from "./content-keys.js";
import {
  contentEncryptionStatus,
  migrateContent,
  rewrapSpaceKeys,
  rotateSpaceDataKeys,
} from "./content-migration.js";
import { appendEventInTransaction } from "./events.js";
import { readHistory, searchHistory } from "./history-retrieval.js";
import { createThreadMessage, createThreadMessageInTransaction } from "./messages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const masterA = { id: "test-a", key: randomBytes(32) };
const masterB = { id: "test-b", key: randomBytes(32) };

describePostgres("content encryption (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `enc-user-${suffix}`;
  const organizationId = `enc-org-${suffix}`;
  const spaceId = `enc-space-${suffix}`;
  const botId = `enc-bot-${suffix}`;
  const threadId = `enc-thread-${suffix}`;
  const scope = { spaceId, userId, threadId, botId };
  const clients: Array<ReturnType<typeof createDb>> = [];
  let prisma: PrismaClient;
  let raw: ReturnType<typeof createDb>["pool"];

  function client(keys = [masterA]) {
    // The derived key keeps rows from other suites sharing this database readable.
    const provider = new LocalKeyProvider([...keys, ...masterKeysFromEnv()]);
    const db = createDb(databaseUrl!, { keyProvider: provider });
    clients.push(db);
    return db;
  }
  const rawBlocks = async (id: string) =>
    (await raw.query(`SELECT blocks::text AS blocks FROM messages WHERE id = $1`, [id])).rows[0]
      .blocks as string;

  beforeAll(async () => {
    ({ prisma, pool: raw } = client());
    await prisma.user.create({
      data: {
        id: userId,
        name: "Encryption",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Encryption", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
    await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
    await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
  });

  afterAll(async () => {
    await prisma?.organization.deleteMany({ where: { id: organizationId } });
    await prisma?.user.deleteMany({ where: { id: userId } });
    for (const db of clients) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("round-trips message blocks and keeps structural filters working", async () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "The launch codeword is MARIGOLD" },
      {
        kind: "channel_message",
        provider: "slack",
        channelId: "channel-1",
        fromAddress: "u1",
        fromLabel: "Grace",
        text: "Ship on Friday",
      },
    ];
    const message = await createThreadMessage(prisma, { threadId, role: "user", blocks });
    expect(message.blocks).toEqual(blocks);
    const stored = await rawBlocks(message.id);
    expect(stored).not.toContain("MARIGOLD");
    expect(stored).not.toContain("Friday");
    expect(stored).toContain("rkz1:");
    const found = await prisma.message.findMany({
      where: {
        threadId,
        blocks: { array_contains: [{ kind: "channel_message", channelId: "channel-1" }] },
      },
      select: { blocks: true },
    });
    expect(found).toEqual([{ blocks }]);
    const nested = await prisma.thread.findUnique({
      where: { id: threadId },
      select: { messages: { select: { blocks: true }, where: { id: message.id } } },
    });
    expect(nested?.messages).toEqual([{ blocks }]);
  });

  it("rejects ciphertext moved to another row", async () => {
    const source = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "secret one" }],
    });
    const target = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "secret two" }],
    });
    await raw.query(
      `UPDATE messages SET blocks = (SELECT blocks FROM messages WHERE id = $1) WHERE id = $2`,
      [source.id, target.id],
    );
    await expect(prisma.message.findUnique({ where: { id: target.id } })).rejects.toBeInstanceOf(
      ContentDecryptionError,
    );
    await prisma.message.delete({ where: { id: target.id }, select: { id: true } });
  });

  it("rejects a message moved to another thread, including through raw reads", async () => {
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "victim text" }],
    });
    const otherBot = `enc-bot-moved-${suffix}`;
    await prisma.bot.create({ data: { id: otherBot, spaceId, userId, name: "Moe", color: "ink" } });
    const other = await prisma.thread.create({ data: { spaceId, userId, botId: otherBot } });
    await raw.query(`UPDATE messages SET "threadId" = $1, seq = 99999 WHERE id = $2`, [
      other.id,
      message.id,
    ]);
    const fresh = client();
    await expect(
      fresh.prisma.message.findUnique({ where: { id: message.id }, select: { blocks: true } }),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
    const rows = (
      await raw.query(`SELECT id, "threadId", blocks FROM messages WHERE id = $1`, [message.id])
    ).rows;
    await expect(
      contentEncryptionOf(fresh.prisma)!.openRows("Message", rows),
    ).rejects.toBeInstanceOf(ContentDecryptionError);
    await raw.query(`DELETE FROM messages WHERE id = $1`, [message.id]);
  });

  it("reads and searches plaintext rows next to encrypted ones, then migrates them", async () => {
    const plaintextId = `enc-plain-${suffix}`;
    await raw.query(
      `INSERT INTO messages (id, "threadId", seq, role, blocks) VALUES ($1, $2, 9000, 'user', $3::jsonb)`,
      [
        plaintextId,
        threadId,
        JSON.stringify([{ kind: "text", text: "legacy note about pelicans" }]),
      ],
    );
    await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      blocks: [{ kind: "text", text: "fresh note about pelicans" }],
    });
    const read = await prisma.message.findUnique({ where: { id: plaintextId } });
    expect(read?.blocks).toEqual([{ kind: "text", text: "legacy note about pelicans" }]);

    const texts = async () =>
      (await searchHistory(prisma, scope, { query: "pelicans" })).messages
        .map((m) => m.text)
        .sort();
    expect(await texts()).toEqual(["fresh note about pelicans", "legacy note about pelicans"]);

    const before = await contentEncryptionStatus(prisma);
    expect(before.tables.find((t) => t.table === "messages")!.plaintext).toBeGreaterThan(0);
    await migrateContent(prisma, { mode: "encrypt" });
    expect(await rawBlocks(plaintextId)).not.toContain("pelicans");
    expect(await texts()).toEqual(["fresh note about pelicans", "legacy note about pelicans"]);
    const after = await contentEncryptionStatus(prisma);
    for (const table of after.tables) expect(table.plaintext, table.table).toBe(0);

    const excerpt = await readHistory(prisma, scope, { messageId: plaintextId, limit: 1 });
    expect(excerpt.messages[0]!.text).toBe("legacy note about pelicans");
  });

  it("encrypts memory, revisions, event payloads and thread summaries", async () => {
    const doc = await prisma.memoryDocument.create({
      data: {
        spaceId,
        userId,
        scope: "user",
        path: `notes-${suffix}.md`,
        content: "Allergic to kiwi",
      },
    });
    await prisma.memoryRevision.create({
      data: { documentId: doc.id, revision: 1, content: "Allergic to kiwi" },
    });
    const updated = await prisma.memoryDocument.update({
      where: { id: doc.id },
      data: { content: "Allergic to kiwi and figs", revision: 2 },
    });
    expect(updated.content).toBe("Allergic to kiwi and figs");
    const stored = await raw.query(
      `SELECT d.content AS doc, r.content AS rev FROM memory_documents d JOIN memory_revisions r ON r."documentId" = d.id WHERE d.id = $1`,
      [doc.id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain("kiwi");
    expect(
      (
        await prisma.memoryDocument.findUnique({
          where: { id: doc.id },
          include: { revisions: true },
        })
      )?.revisions[0]?.content,
    ).toBe("Allergic to kiwi");

    const event = await prisma.$transaction((tx) =>
      appendEventInTransaction(tx, {
        spaceId,
        threadId,
        botId,
        type: "thread.message.created",
        payload: { messageId: "m-1", notice: "stuck", blocks: [{ kind: "text", text: "quokka" }] },
      }),
    );
    expect(
      JSON.stringify(
        (await raw.query(`SELECT payload FROM events WHERE id = $1`, [event.id])).rows,
      ),
    ).not.toContain("quokka");
    const byPath = await prisma.event.findMany({
      where: { threadId, payload: { path: ["notice"], equals: "stuck" } },
    });
    expect(byPath.map((row) => row.payload)).toEqual([
      { messageId: "m-1", notice: "stuck", blocks: [{ kind: "text", text: "quokka" }] },
    ]);

    await prisma.thread.update({
      where: { id: threadId },
      data: { historyCompactionSummary: "They discussed the wombat budget" },
    });
    expect(
      (
        await raw.query(`SELECT "historyCompactionSummary" AS s FROM threads WHERE id = $1`, [
          threadId,
        ])
      ).rows[0].s,
    ).toMatch(/^rkz1:/);
    expect(
      (await prisma.thread.findUnique({ where: { id: threadId } }))?.historyCompactionSummary,
    ).toBe("They discussed the wombat budget");
  });

  it("creates a thread and its first message in one transaction", async () => {
    const otherBot = `enc-bot-2-${suffix}`;
    await prisma.bot.create({ data: { id: otherBot, spaceId, userId, name: "Lin", color: "ink" } });
    const message = await prisma.$transaction(async (tx) => {
      const thread = await tx.thread.create({ data: { spaceId, userId, botId: otherBot } });
      return createThreadMessageInTransaction(tx, {
        threadId: thread.id,
        role: "user",
        blocks: [{ kind: "text", text: "first words" }],
      });
    });
    expect(await rawBlocks(message.id)).not.toContain("first words");
  });

  it("rejects nested writes that would store plaintext", async () => {
    await expect(
      prisma.thread.create({
        data: {
          spaceId,
          userId,
          messages: { create: { seq: 0, role: "user", blocks: [{ kind: "text", text: "x" }] } },
        },
      }),
    ).rejects.toThrow(/nested write/);
  });

  it("re-wraps space keys under a new master key and re-encrypts content", async () => {
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "rotation survives axolotls" }],
    });
    const rotating = client([masterB, masterA]);
    const keys = contentEncryptionOf(rotating.prisma)!.ring;
    expect(await rewrapSpaceKeys(rotating.prisma, keys)).toMatchObject({
      rewrapped: expect.any(Number),
    });
    const masters = await raw.query(
      `SELECT DISTINCT "masterKeyId" FROM space_keys WHERE "spaceId" = $1`,
      [spaceId],
    );
    expect(masters.rows).toEqual([{ masterKeyId: "test-b" }]);

    const onlyB = client([masterB]);
    expect((await onlyB.prisma.message.findUnique({ where: { id: message.id } }))?.blocks).toEqual([
      { kind: "text", text: "rotation survives axolotls" },
    ]);
    const onlyA = client([masterA]);
    await expect(onlyA.prisma.message.findUnique({ where: { id: message.id } })).rejects.toThrow(
      /Master key test-b is not configured/,
    );

    const before = (await rawBlocks(message.id)).match(/rkz1:([^:]+):/)![1];
    await rotateSpaceDataKeys(onlyB.prisma, contentEncryptionOf(onlyB.prisma)!.ring);
    await migrateContent(onlyB.prisma, { mode: "reencrypt" });
    const afterKey = (await rawBlocks(message.id)).match(/rkz1:([^:]+):/)![1];
    expect(afterKey).not.toBe(before);
    const versions = await raw.query(
      `SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`,
      [spaceId],
    );
    expect(versions.rows[0].n).toBe(2);
    const search = await searchHistory(onlyB.prisma, scope, { query: "axolotls" });
    expect(search.messages.map((m) => m.messageId)).toEqual([message.id]);
  });

  it("writes plaintext back for a rollback", async () => {
    const db = client([masterB]);
    await migrateContent(db.prisma, { mode: "decrypt" });
    const stored = await raw.query(
      `SELECT count(*)::int AS n FROM messages WHERE "threadId" = $1 AND blocks::text LIKE '%rkz1:%'`,
      [threadId],
    );
    expect(stored.rows[0].n).toBe(0);
    expect(await rawBlocks(`enc-plain-${suffix}`)).toContain("pelicans");
    await migrateContent(db.prisma, { mode: "encrypt" });
  });

  it("destroys a space's keys when the space is deleted", async () => {
    const doomed = `enc-doomed-${suffix}`;
    await prisma.space.create({ data: { id: doomed, organizationId, name: "Doomed" } });
    await prisma.memoryDocument.create({
      data: { spaceId: doomed, userId, scope: "user", path: "MEMORY.md", content: "gone soon" },
    });
    const count = async () =>
      (await raw.query(`SELECT count(*)::int AS n FROM space_keys WHERE "spaceId" = $1`, [doomed]))
        .rows[0].n;
    expect(await count()).toBe(1);
    await prisma.space.delete({ where: { id: doomed } });
    expect(await count()).toBe(0);
  });
});
