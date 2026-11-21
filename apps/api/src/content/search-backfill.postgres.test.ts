import type { Actor } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import {
  backfillMessageSearchIndex,
  createDb,
  encryptText,
  LocalKeyProvider,
  masterKeysFromEnv,
  messageBlockSearchInput,
  querySearchTokens,
  runAsSystem,
  searchTokens,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { querySpaceSearch } from "./search.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("encrypted message search index backfill (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `backfill-user-${suffix}`;
  const organizationId = `backfill-org-${suffix}`;
  const spaceId = `backfill-space-${suffix}`;
  const threadId = `backfill-thread-${suffix}`;
  const botId = `backfill-bot-${suffix}`;
  const id = (seq: number) => `backfill-message-${suffix}-${seq}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let writer: ReturnType<typeof createDb>;
  let resumed: ReturnType<typeof createDb>;
  let provider: LocalKeyProvider;
  const system = <T>(work: () => Promise<T>) => runAsSystem("search backfill fixture", work);
  const put = (
    db: typeof writer,
    seq: number,
    blocks: Prisma.InputJsonArray,
    toolHistory?: string,
  ) =>
    db.prisma.message.create({
      data: { id: id(seq), threadId, seq, role: "bot", botId, blocks, toolHistory },
    });
  const stored = async (seq: number) =>
    (
      await writer.pool.query<{
        blocks: string;
        toolHistory: string | null;
        tokens: number[] | null;
      }>(
        'SELECT blocks::text AS blocks, "toolHistory", "searchTokens" AS tokens FROM messages WHERE id = $1',
        [id(seq)],
      )
    ).rows[0]!;
  const matches = async (query: string) =>
    (await querySpaceSearch(resumed.prisma, actor, query))
      .filter((hit) => hit.kind === "message")
      .map((hit) => hit.messageId);

  beforeAll(() =>
    system(async () => {
      writer = createDb(databaseUrl!, { encryptContent: true });
      provider = new LocalKeyProvider(masterKeysFromEnv());
      resumed = createDb(databaseUrl!, { encryptContent: false, keyProvider: provider });
      await writer.prisma.user.create({
        data: { id: userId, name: "Search", email: actor.email, emailVerified: true },
      });
      await writer.prisma.organization.create({
        data: { id: organizationId, name: "Search", slug: organizationId, createdAt: new Date() },
      });
      await writer.prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await writer.prisma.bot.create({
        data: { id: botId, spaceId, userId, name: "Search", color: "ink" },
      });
      await writer.prisma.thread.create({ data: { id: threadId, botId, spaceId, userId } });
    }),
  );

  afterEach(() =>
    system(async () => {
      vi.restoreAllMocks();
      await writer.pool.query('DELETE FROM message_search_backfill WHERE "throughId" IN ($1, $2)', [
        id(5),
        id(7),
      ]);
      await writer.prisma.message.deleteMany({ where: { threadId } });
    }),
  );

  afterAll(async () => {
    try {
      await system(async () => {
        await writer?.prisma.organization.deleteMany({ where: { id: organizationId } });
        await writer?.prisma.user.deleteMany({ where: { id: userId } });
      });
    } finally {
      for (const db of [writer, resumed]) {
        await db?.prisma.$disconnect();
        await db?.pool.end();
      }
    }
  });

  it("resumes past committed batches and finds an old encrypted message by its interior Han pair", () =>
    system(async () => {
      // The integration harness gives this deployment-wide operation its own migrated database.
      expect(await writer.prisma.message.findFirst({ select: { id: true } })).toBeNull();
      const texts = ["今天安排交付时间", "我们今天讨论部署方案", "下周整理归档记录"];
      const key = await writer.contentKeys.current(spaceId);
      const originals = [];
      for (const [i, text] of texts.entries()) {
        const seq = i + 1;
        const blocks: Prisma.JsonArray = [{ kind: "text", text }];
        if (seq === 1)
          blocks.push(
            {
              kind: "file",
              artifactId: "fixture-file",
              name: "lantern.txt",
              mimeType: "text/plain",
              size: 1,
            },
            { kind: "steps", steps: [{ label: "Review", count: 1, note: "Marigold" }] },
            { kind: "earlier_annotation", note: "Windmill" },
            { missingKind: "Woodpecker" },
          );
        const toolHistory =
          seq === 1
            ? JSON.stringify({ steps: [{ calls: [{ result: "Kingfisher" }] }] })
            : undefined;
        const message = await put(writer, seq, blocks, toolHistory);
        originals.push(await stored(seq));
        // The old writer saw each unspaced sentence as one prefix-searchable term.
        const legacy = searchTokens(key, messageBlockSearchInput(message.blocks), "prefix");
        await writer.pool.query('UPDATE messages SET "searchTokens" = $1 WHERE id = $2', [
          legacy,
          id(seq),
        ]);
      }
      await writer.contentKeys.rotate(spaceId);
      await put(writer, 4, [{ kind: "text", text: "新消息也有索引" }]);
      await put(resumed, 5, [{ kind: "text", text: "未加密的消息" }]);
      const untouched = [await stored(4), await stored(5)];

      expect(await matches("我们今天")).toEqual([id(2)]);
      expect(await matches("部署")).toEqual([]);
      expect(await matches("Windmill")).toEqual([id(1)]);
      expect(await matches("Woodpecker")).toEqual([]);
      expect(
        await backfillMessageSearchIndex(writer.prisma, { batchSize: 1, maxBatches: 1 }),
      ).toEqual({ scanned: 1, updated: 1, complete: false });
      const rebuilt = await stored(1);
      expect(rebuilt.blocks).toBe(originals[0]!.blocks);
      expect(rebuilt.toolHistory).toBe(originals[0]!.toolHistory);
      expect(await matches("Windmill")).toEqual([id(1)]);
      expect(await matches("Woodpecker")).toEqual([]);
      expect(rebuilt.tokens).not.toContain(querySearchTokens(key, "woodpecker", "prefix")[0]);
      for (const word of ["lantern", "review", "marigold"])
        expect(rebuilt.tokens).toEqual(
          expect.arrayContaining(querySearchTokens(key, word, "word")),
        );
      expect(rebuilt.tokens).not.toContain(querySearchTokens(key, "kingfisher", "word")[0]);
      expect(rebuilt.tokens).not.toContain(querySearchTokens(key, "kingfisher", "prefix")[0]);
      expect(await matches("部署")).toEqual([]);
      await put(writer, 6, [{ kind: "text", text: "消息追加时间已确定" }]);
      expect(await matches("追加")).toEqual([id(6)]);

      // The second row of the batch is unreadable. The error must identify it
      // without exposing the envelope or plaintext, and preserve the previous checkpoint.
      const foreignSpace = await writer.prisma.space.create({
        data: { id: `${spaceId}-other`, name: "Other", organizationId },
      });
      const foreignKey = await writer.contentKeys.current(foreignSpace.id);
      const location = { table: "messages", column: "blocks", rowId: id(3), owner: threadId };
      const content = JSON.stringify({ kind: "text", text: "private fixture text" });
      const invalidEnvelopes = [
        null,
        "rkz1:missing-fixture-key:invalid",
        encryptText(foreignKey, location, content),
        encryptText(key, { ...location, rowId: id(2) }, content),
        encryptText(key, location, "private malformed JSON fixture"),
      ];
      for (const envelope of invalidEnvelopes) {
        await writer.pool.query(
          "UPDATE messages SET blocks = $1::jsonb || $2::jsonb WHERE id = $3",
          [originals[2]!.blocks, JSON.stringify([{ kind: "text", $sealed: envelope }]), id(3)],
        );
        await expect(
          backfillMessageSearchIndex(resumed.prisma, { batchSize: 2 }),
        ).rejects.toMatchObject({
          name: "ContentDecryptionError",
          message: `Could not read encrypted blocks for message ${id(3)}`,
        });
        expect(await matches("部署")).toEqual([]);
      }
      await writer.pool.query("UPDATE messages SET blocks = $1::jsonb WHERE id = $2", [
        originals[2]!.blocks,
        id(3),
      ]);

      const stop = new AbortController();
      expect(
        await backfillMessageSearchIndex(resumed.prisma, {
          batchSize: 2,
          signal: stop.signal,
          report: () => stop.abort(),
        }),
      ).toEqual({ scanned: 2, updated: 2, complete: false });
      expect(await matches("部署")).toEqual([id(2)]);
      expect(await matches("我们今天")).toEqual([id(2)]);
      // Exact stored equality checks ciphertext preservation and use of the original space key.
      expect(await stored(2)).toEqual(originals[1]);
      expect(await stored(3)).toEqual(originals[2]);

      expect(await backfillMessageSearchIndex(writer.prisma, { batchSize: 2 })).toEqual({
        scanned: 2,
        updated: 0,
        complete: true,
      });
      expect([await stored(4), await stored(5)]).toEqual(untouched);
      expect(await backfillMessageSearchIndex(resumed.prisma)).toEqual({
        scanned: 0,
        updated: 0,
        complete: true,
      });
    }));

  it("propagates key-provider and database failures so the same batch can be retried", () =>
    system(async () => {
      const text = "我们今天讨论部署方案";
      const key = await writer.contentKeys.current(spaceId);
      const message = await put(writer, 7, [{ kind: "text", text }]);
      const prefix = searchTokens(key, messageBlockSearchInput(message.blocks), "prefix");
      await writer.pool.query('UPDATE messages SET "searchTokens" = $1 WHERE id = $2', [
        prefix,
        message.id,
      ]);
      resumed.contentKeys.clear();
      const providerError = new SyntaxError("Invalid key service response");
      vi.spyOn(provider, "unwrap").mockRejectedValueOnce(providerError);
      await expect(backfillMessageSearchIndex(resumed.prisma)).rejects.toBe(providerError);

      const databaseError = Object.assign(new Error("Connection lost"), { code: "08006" });
      vi.spyOn(resumed.contentKeys, "spaceOf").mockRejectedValueOnce(databaseError);
      await expect(backfillMessageSearchIndex(resumed.prisma)).rejects.toBe(databaseError);

      expect((await stored(7)).tokens).toEqual(prefix);
      expect(await backfillMessageSearchIndex(resumed.prisma)).toEqual({
        scanned: 1,
        updated: 1,
        complete: true,
      });
      expect(await matches("部署")).toEqual([message.id]);
    }));
});
