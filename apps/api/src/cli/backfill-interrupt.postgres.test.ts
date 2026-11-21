import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb, runAsSystem } from "@rakazo/db";
import { expect, it } from "vitest";

const test = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? it : it.skip;
const cli = fileURLToPath(new URL("./content-encryption.ts", import.meta.url));

function runBackfill(args: string[], signal?: "SIGINT" | "SIGTERM") {
  const loader = ["--import", import.meta.resolve("tsx")];
  if (signal) {
    // Inject at a committed batch boundary, including on Windows where killing a
    // process with SIGTERM terminates it without invoking Node's signal handler.
    const preload = `
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => {
        const result = write(chunk, ...args);
        if (String(chunk).startsWith("Checked ")) {
          process.stdout.write = write;
          process.emit("${signal}", "${signal}");
        }
        return result;
      };`;
    loader.push("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  return spawnSync(
    process.execPath,
    [...loader, cli, "backfill-search", "--batch-size", "1", ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

test("signals and scheduled pauses preserve progress and return distinct process exit codes", async () => {
  const db = createDb(process.env.DATABASE_URL!, { encryptContent: true });
  const fixture = `backfill-interrupt-${process.pid}`;
  try {
    await runAsSystem("backfill CLI exit-code fixture", async () => {
      // The integration harness gives this whole-deployment command an empty database.
      expect(await db.prisma.message.count()).toBe(0);
      expect(await db.prisma.messageSearchBackfill.count()).toBe(0);
      await db.prisma.user.create({
        data: { id: fixture, name: "Search", email: `${fixture}@test.invalid` },
      });
      await db.prisma.organization.create({
        data: { id: fixture, name: "Search", slug: fixture, createdAt: new Date() },
      });
      await db.prisma.space.create({
        data: { id: fixture, organizationId: fixture, name: "Search" },
      });
      await db.prisma.bot.create({
        data: { id: fixture, name: "Search", color: "ink", userId: fixture, spaceId: fixture },
      });
      await db.prisma.thread.create({
        data: { id: fixture, botId: fixture, userId: fixture, spaceId: fixture },
      });
      const rows = [1, 2, 3, 4].map((seq) => ({
        id: `${fixture}-${seq}`,
        seq,
        threadId: fixture,
        role: "user",
        blocks: [{ kind: "text", text: "部署方案" }],
      }));
      await db.prisma.message.createMany({ data: rows });
      await db.prisma
        .$executeRaw`UPDATE messages SET "searchTokens" = NULL WHERE "threadId" = ${fixture}`;

      const pauses = [
        ["SIGINT", 130],
        ["SIGTERM", 143],
        [undefined, 0],
      ] as const;
      for (const [index, [signal, exitCode]] of pauses.entries()) {
        const result = runBackfill(signal ? [] : ["--max-batches", "1"], signal);
        expect(result.status, result.error?.message ?? result.stderr).toBe(exitCode);
        expect(result.stdout).toContain("Backfill paused");
        const checkpoint = await db.prisma.messageSearchBackfill.findFirstOrThrow();
        expect(checkpoint.afterId).toBe(rows[index]!.id);
      }
      const resumed = runBackfill([]);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain("Checked 1 messages, updated 1 search indexes this run.");
      expect(resumed.stdout).toContain("Backfill complete");
      expect(
        await db.prisma.message.count({
          where: { threadId: fixture, searchTokens: { isEmpty: false } },
        }),
      ).toBe(rows.length);
    });
  } finally {
    await runAsSystem("remove backfill CLI exit-code fixture", async () => {
      await db.prisma.messageSearchBackfill.deleteMany({ where: { throughId: `${fixture}-4` } });
      await db.prisma.organization.deleteMany({ where: { id: fixture } });
      await db.prisma.user.deleteMany({ where: { id: fixture } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}, 120_000);
