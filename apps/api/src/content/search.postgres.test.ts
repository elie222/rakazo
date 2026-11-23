import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessage, runAsSystem, runAsTenant, searchTokens } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { querySpaceSearch } from "./search.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("space search with CONTENT_ENCRYPTION on and off (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `search-switch-user-${suffix}`;
  const organizationId = `search-switch-org-${suffix}`;
  const spaceId = `search-switch-space-${suffix}`;
  const botId = `search-switch-bot-${suffix}`;
  const threadId = `search-switch-thread-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let on: ReturnType<typeof createDb>;
  let off: ReturnType<typeof createDb>;

  const system = <T>(work: () => Promise<T>) => runAsSystem("test fixture", work);
  const say = (prisma: PrismaClient, text: string) =>
    createThreadMessage(prisma, { threadId, role: "bot", botId, blocks: [{ kind: "text", text }] });
  const snippets = async (prisma: PrismaClient, query: string) =>
    (await querySpaceSearch(prisma, actor, query))
      .filter((hit) => hit.kind === "message")
      .map((hit) => hit.snippet)
      .sort();
  const messageIds = (prisma: PrismaClient, query: string) =>
    runAsTenant(actor, async () =>
      (await querySpaceSearch(prisma, actor, query))
        .filter((hit) => hit.kind === "message")
        .map((hit) => hit.messageId),
    );
  const oldTokens = async (text: string) =>
    searchTokens(await on.contentKeys.current(spaceId), {
      words: text,
      strings: ["text", text],
    });
  // Seed ciphertext with the original writer's tokens, under the key used to seal the row.
  const sayWithOriginalIndex = async (text: string) => {
    const message = await say(on.prisma, text);
    const tokens = await oldTokens(text);
    await on.pool.query('UPDATE messages SET "searchTokens" = $1::int[] WHERE id = $2', [
      tokens,
      message.id,
    ]);
    return message;
  };
  const addNewerMessages = (after: Date, firstSeq: number, text: string) =>
    on.prisma.message.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        threadId,
        seq: firstSeq + index,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text }],
        createdAt: new Date(after.getTime() + index + 1),
      })),
    });

  beforeAll(() =>
    system(async () => {
      on = createDb(databaseUrl!, { encryptContent: true });
      off = createDb(databaseUrl!, { encryptContent: false });
      const prisma = on.prisma;
      await prisma.user.create({
        data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Search", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    }),
  );

  afterAll(async () => {
    await on?.prisma.organization.deleteMany({ where: { id: organizationId } });
    await on?.prisma.user.deleteMany({ where: { id: userId } });
    for (const db of [on, off]) {
      await db?.prisma.$disconnect();
      await db?.pool.end();
    }
  });

  it("finds plaintext, encrypted and mixed messages in both modes", () =>
    system(async () => {
      // Off from the start: no keys, plain substring search, including inside words.
      const plain = await say(off.prisma, "the capybara plan");
      expect(await snippets(off.prisma, "capybara")).toEqual(["the capybara plan"]);
      expect(await snippets(off.prisma, "apyba")).toEqual(["the capybara plan"]);

      // Mixed: an encrypted message beside the plaintext one.
      await say(on.prisma, "the capybara budget");
      const both = ["the capybara budget", "the capybara plan"];
      for (const db of [on, off]) expect(await snippets(db.prisma, "capybara")).toEqual(both);

      // All encrypted: rewriting the plaintext row with encryption on seals it, as
      // `content-encryption migrate` does row by row.
      await on.prisma.message.update({
        where: { id: plain.id },
        data: { blocks: [{ kind: "text", text: "the capybara plan" }] },
        select: { id: true },
      });
      for (const db of [on, off]) expect(await snippets(db.prisma, "capybara")).toEqual(both);

      // Rewritten with encryption off again, it is found by its new text only.
      await off.prisma.message.update({
        where: { id: plain.id },
        data: { blocks: [{ kind: "text", text: "the capybara roadmap" }] },
        select: { id: true },
      });
      for (const db of [on, off]) {
        expect(await snippets(db.prisma, "capybara")).toEqual([
          "the capybara budget",
          "the capybara roadmap",
        ]);
        expect(await snippets(db.prisma, "plan")).toEqual([]);
      }
    }));

  it("never returns a delivery, plaintext or encrypted", () =>
    system(async () => {
      for (const db of [off, on]) {
        await createThreadMessage(db.prisma, {
          threadId,
          role: "user",
          blocks: [{ kind: "delivery" }, { kind: "text", text: "wombat lead payload" }],
        });
      }
      await say(on.prisma, "the wombat summary");
      for (const db of [on, off]) {
        expect(await snippets(db.prisma, "wombat")).toEqual(["the wombat summary"]);
      }
    }));

  it("finds Chinese and mixed-script interiors while preserving old prefixes across rotation", () =>
    system(async () => {
      const legacy = await sayWithOriginalIndex("我们今天讨论部署方案");
      expect(await messageIds(on.prisma, "我们今天")).toEqual([legacy.id]);
      expect(await messageIds(on.prisma, "部署")).toEqual([]);

      await on.contentKeys.rotate(spaceId);
      const mixed = await say(on.prisma, "今晚部署API服务");
      const spaced = await say(on.prisma, "明早部署 API 服务");
      for (const db of [on, off]) {
        expect(await messageIds(db.prisma, "我们今天")).toEqual([legacy.id]);
        const chineseHits = await messageIds(db.prisma, "部署");
        expect(chineseHits).toHaveLength(2);
        expect(chineseHits).toEqual(expect.arrayContaining([mixed.id, spaced.id]));
        for (const query of ["部署API", "署A", "I服"]) {
          expect(await messageIds(db.prisma, query), query).toEqual([mixed.id]);
        }
        expect(await messageIds(db.prisma, "部署 API")).toEqual([spaced.id]);
      }
    }));

  it("finds an exact pair hit outside the newest 500 old-prefix candidates", () =>
    system(async () => {
      const query = "我们今天讨论部署方案细节";
      // Both representations qualify the target. The newer rows match the first
      // ten characters (the full indexed prefix), without the final Han pairs.
      const target = await say(on.prisma, query);
      await addNewerMessages(target.createdAt, 10_000, "我们今天讨论部署方案成本");
      expect(await messageIds(on.prisma, query)).toEqual([target.id]);
    }));

  it("applies group eligibility to mixed-script candidates", () =>
    system(async () => {
      const peer = await on.prisma.bot.create({
        data: { spaceId, userId, name: "Piper", color: "ink" },
      });
      const group = await on.prisma.chatGroup.create({
        data: {
          spaceId,
          userId,
          name: "Group",
          members: { create: [{ botId }, { botId: peer.id }] },
        },
      });
      const thread = await on.prisma.thread.create({
        data: { spaceId, userId, groupId: group.id },
      });
      const message = await createThreadMessage(on.prisma, {
        threadId: thread.id,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "今晚导入JSON数据" }],
      });
      expect(await messageIds(on.prisma, "入JSON")).toEqual([message.id]);
      await on.prisma.bot.update({ where: { id: peer.id }, data: { archivedAt: new Date() } });
      expect(await messageIds(on.prisma, "入JSON")).toEqual([]);
    }));

  it("finds an original prefix hit outside the newest 500 pair candidates", () =>
    system(async () => {
      const target = await sayWithOriginalIndex("归档期限已经确认");
      // These rows have both query pairs, 归档 and 档期, in different phrases.
      // Their original prefixes never match 归档期.
      await addNewerMessages(target.createdAt, 20_000, "确认归档，存档期限");
      expect(await messageIds(on.prisma, "归档期")).toEqual([target.id]);
    }));

  it("keeps the stored index small for an 84,000-character mixed run and finds its tail", () =>
    system(async () => {
      const dense = Array.from({ length: 12_000 }, (_, index) => `中${100_000 + index}`).join("");
      const text = `${dense}部署API`;
      const target = await say(on.prisma, text);
      const { rows } = await on.pool.query<{ searchTokens: number[] }>(
        'SELECT "searchTokens" FROM messages WHERE id = $1',
        [target.id],
      );
      const tokens = rows[0]!.searchTokens;
      const original = await oldTokens(text);
      expect(tokens).toEqual(expect.arrayContaining(original));
      // Only a small set of Han/digit boundary pairs repeats in this string.
      // Splitting and indexing the distinct numeric runs emitted 13,361 tokens.
      expect(tokens.length - original.length).toBeGreaterThan(0);
      expect(tokens.length - original.length).toBeLessThanOrEqual(32);
      // Check the actual tail without assuming every pair fits in a diverse long message.
      expect(await messageIds(on.prisma, "999部署API")).toEqual([target.id]);
    }));
});
