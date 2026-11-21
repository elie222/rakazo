import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  createThreadMessage,
  querySearchTokens,
  runAsSystem,
  searchTokens,
} from "@rakazo/db";
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

  it("finds Chinese and mixed-script text beside prefix-only messages from an older key", () =>
    system(async () => {
      const legacyText = "部署API方案";
      const legacy = await say(on.prisma, legacyText);
      const oldKey = await on.contentKeys.current(spaceId);
      // Recreate the pre-bigram index for this exact text block. Do not ask the
      // current writer for its tokens: that would silently upgrade the fixture.
      const oldPrefixes = [
        "te",
        "tex",
        "text",
        "部署",
        "部署A",
        "部署AP",
        "部署API",
        "部署API方",
        legacyText,
      ];
      const legacyTokens = [
        ...querySearchTokens(oldKey, legacyText, "word"),
        ...oldPrefixes.flatMap((prefix) => querySearchTokens(oldKey, prefix, "prefix")),
      ];
      await on.pool.query('UPDATE messages SET "searchTokens" = $1::int[] WHERE id = $2', [
        legacyTokens,
        legacy.id,
      ]);

      const mixedText = "今晚讨论部署API方案";
      await say(on.prisma, mixedText);
      await on.contentKeys.rotate(spaceId);
      const chineseText = "我们今天讨论部署方案";
      const separatedText = "API方案先讨论，部署另排";
      await say(on.prisma, chineseText);
      await say(on.prisma, separatedText);

      // Both encodings and keys must qualify independently. The message with
      // all the query's pieces in the wrong order is dropped after decryption.
      expect(await snippets(on.prisma, "部署api")).toEqual([legacyText, mixedText].sort());
      expect(await snippets(on.prisma, "论部")).toEqual([chineseText, mixedText].sort());
      expect(await snippets(on.prisma, "api方案")).toContain(mixedText);
      // A lone Han character still uses the bounded recent-message scan.
      expect(await snippets(on.prisma, "今")).toEqual([chineseText, mixedText].sort());
    }));

  it("keeps prefix matches when newer compact false positives fill their search window", () =>
    system(async () => {
      const legacyText = "鲸落CDN旧记录";
      const legacy = await say(on.prisma, legacyText);
      const key = await on.contentKeys.current(spaceId);
      await on.pool.query('UPDATE messages SET "searchTokens" = $1::int[] WHERE id = $2', [
        searchTokens(key, { words: legacyText, strings: ["text", legacyText] }, "prefix"),
        legacy.id,
      ]);
      // Sequential pairs fill all compact buckets. These newer messages share
      // the CDN prefix but do not contain the requested Han pair.
      const filler = Array.from({ length: 300 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(
        "",
      );
      await on.prisma.message.createMany({
        data: Array.from({ length: 501 }, (_, i) => ({
          threadId,
          seq: 100_000 + i,
          role: "bot",
          botId,
          blocks: [{ kind: "text", text: `${filler}CDN` }],
        })),
      });
      const tail = await say(on.prisma, `${filler}鲸落CDN新记录`);
      const hits = await querySpaceSearch(on.prisma, actor, "鲸落cdn");
      expect(hits.filter((hit) => hit.kind === "message").map((hit) => hit.messageId)).toEqual([
        tail.id,
        legacy.id,
      ]);
    }));

  it("reserves historical prefix matches before and after reindexing when exact pairs are noisy", () =>
    system(async () => {
      const text = "归档期限 归档 期限已定";
      const legacy = await say(on.prisma, text);
      const key = await on.contentKeys.current(spaceId);
      await on.pool.query('UPDATE messages SET "searchTokens" = $1::int[] WHERE id = $2', [
        searchTokens(key, { words: text, strings: ["text", text] }),
        legacy.id,
      ]);
      // Both queries' pairs appear in newer messages, but in the wrong order
      // or with different punctuation. Neither qualified for the original window.
      await on.prisma.message.createMany({
        data: Array.from({ length: 501 }, (_, i) => ({
          threadId,
          seq: 200_000 + i,
          role: "bot",
          botId,
          blocks: [{ kind: "text", text: "确认归档，存档期限" }],
        })),
      });
      const verify = async () => {
        for (const query of ["归档期", "归档 期限"]) {
          expect(await snippets(on.prisma, query)).toEqual([text]);
        }
      };
      await verify();
      await on.prisma.message.update({
        where: { id: legacy.id },
        data: { blocks: [{ kind: "text", text }] },
        select: { id: true },
      });
      await verify();
    }));

  it("finds literal mixed-script boundaries in either direction", () =>
    system(async () => {
      const target = await say(on.prisma, "已经部署API服务，单号９𠮷Ｂ。");
      const spaced = await say(on.prisma, "另行签署 API，示例PI 服务，单号９ 𠮷 Ｂ。");
      const ids = async (query: string) =>
        (await querySpaceSearch(on.prisma, actor, query))
          .filter(
            (hit) => hit.kind === "message" && [target.id, spaced.id].includes(hit.messageId!),
          )
          .map((hit) => hit.messageId);
      for (const query of ["署A", "署ap", "I服", "PI服务", "９𠮷", "𠮷ｂ"])
        expect(await ids(query), query).toEqual([target.id]);
      expect(await ids("署 A")).toEqual([spaced.id]);
      // Index normalization admits these candidates. The literal check keeps
      // the same width-sensitive behavior as the rest of Space search.
      expect(await ids("9𠮷")).toEqual([]);
    }));
});
