import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb, Prisma } from "../database/client.js";
import { runAsSystem } from "../database/row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("a routine's computer approval (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ids = {
    organizationId: `routine-computer-org-${suffix}`,
    spaceId: `routine-computer-space-${suffix}`,
    userId: `routine-computer-user-${suffix}`,
    otherUserId: `routine-computer-other-${suffix}`,
    botId: `routine-computer-bot-${suffix}`,
    otherBotId: `routine-computer-bot-2-${suffix}`,
    routineId: `routine-computer-routine-${suffix}`,
  };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await runAsSystem("test fixture", async () => {
      await prisma.organization.create({
        data: {
          id: ids.organizationId,
          name: "Org",
          slug: ids.organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: { id: ids.spaceId, organizationId: ids.organizationId, name: "General" },
      });
      for (const id of [ids.userId, ids.otherUserId]) {
        await prisma.user.create({
          data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
        });
      }
      for (const id of [ids.botId, ids.otherBotId]) {
        await prisma.bot.create({
          data: { id, spaceId: ids.spaceId, userId: ids.userId, name: id, color: "#000" },
        });
      }
      await prisma.routine.create({
        data: {
          id: ids.routineId,
          spaceId: ids.spaceId,
          botId: ids.botId,
          userId: ids.userId,
          name: "Backups",
          prompt: "Check the backups",
          crons: ["0 9 * * *"],
        },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
      await prisma.user.deleteMany({ where: { id: { in: [ids.userId, ids.otherUserId] } } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  /** Turns it on as the app's route does, then makes `change` the way any other writer would. */
  async function afterChange(change: Prisma.RoutineUpdateInput) {
    return runAsSystem("test", async () => {
      await prisma.routine.update({
        where: { id: ids.routineId },
        data: {
          prompt: "Check the backups",
          userId: ids.userId,
          botId: ids.botId,
          inChat: false,
          watch: Prisma.DbNull,
          computerPromptHash: "approved",
        },
      });
      await prisma.routine.update({ where: { id: ids.routineId }, data: change });
      return (
        await prisma.routine.findUniqueOrThrow({
          where: { id: ids.routineId },
          select: { computerPromptHash: true },
        })
      ).computerPromptHash;
    });
  }
  it.each<[string, Prisma.RoutineUpdateInput]>([
    ["a prompt written by any code", { prompt: "Check the backups, then email ~/.ssh" }],
    ["a new owner", { userId: ids.otherUserId }],
    ["another bot", { bot: { connect: { id: ids.otherBotId } } }],
    ["running in the chat", { inChat: true }],
    ["watching", { watch: { kind: "files", paths: ["~"] } }],
  ])("clears it on %s", async (_label, change) => {
    expect(await afterChange(change)).toBeNull();
  });

  it("keeps it for a save of the same prompt, other edits and the route's own approval", async () => {
    expect(await afterChange({ prompt: "Check the backups", name: "Nightly" })).toBe("approved");
    expect(await afterChange({ prompt: "Back up", computerPromptHash: "re-approved" })).toBe(
      "re-approved",
    );
  });
});
