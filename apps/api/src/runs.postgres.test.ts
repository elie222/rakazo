import type { Actor } from "@rakazo/contracts";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSpaceRuns } from "./runs.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("run activity ordering and scope (PostgreSQL)", () => {
  const prefix = `activity-${process.pid}-${Date.now()}`;
  const actor: Actor = { spaceId: `${prefix}-space`, userId: `${prefix}-user` };
  const organizationId = `${prefix}-org`;
  const otherSpace = `${prefix}-other-space`;
  const otherUser = `${prefix}-other-user`;
  let db: ReturnType<typeof createDb>;
  const system = <T>(work: () => Promise<T>) => runAsSystem("activity test fixture", work);
  const eligible: Array<{ id: string; completedAt: Date | null; updatedAt: Date }> = [];
  const groupId = `${prefix}-group`;

  beforeAll(() =>
    system(async () => {
      db = createDb(databaseUrl!, { encryptContent: false });
      const prisma = db.prisma;
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: "Synthetic",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      for (const id of [actor.spaceId, otherSpace])
        await prisma.space.create({
          data: { id, organizationId, name: "General", isDefault: id === actor.spaceId },
        });
      for (const id of [actor.userId, otherUser]) {
        await prisma.user.create({ data: { id, name: "Synthetic", email: `${id}@example.test` } });
        await prisma.member.create({
          data: { id, organizationId, userId: id, role: "member", createdAt: new Date() },
        });
      }
      await prisma.chatGroup.create({
        data: { id: groupId, spaceId: actor.spaceId, userId: actor.userId, name: "Team" },
      });
      for (const [name, spaceId, userId] of [
        ["main", actor.spaceId, actor.userId],
        ["archived", actor.spaceId, actor.userId],
        ["foreign-user", actor.spaceId, otherUser],
        ["foreign-space", otherSpace, actor.userId],
        ["group", actor.spaceId, actor.userId],
      ] as const) {
        const id = `${prefix}-${name}`;
        await prisma.bot.create({
          data: {
            id,
            spaceId,
            userId,
            name,
            color: "ink",
            notifyOnFinish: false,
            archivedAt: name === "archived" ? new Date() : null,
          },
        });
        await prisma.thread.create({
          data: { id, spaceId, userId, ...(name === "group" ? { groupId } : { botId: id }) },
        });
        await prisma.task.create({
          data: {
            id,
            spaceId,
            userId,
            botId: id,
            threadId: id,
            status: "completed",
            prompt: `Synthetic ${name} prompt`,
          },
        });
        const count = name === "main" ? 60 : 1;
        for (let i = 0; i < count; i++) {
          const completedAt =
            name === "group" || (name === "main" && i < 3)
              ? null
              : new Date(Date.UTC(2026, 1, 1) + Math.floor(i / 3) * 1000);
          const updatedAt = new Date(Date.UTC(2026, 2, 1) + Math.floor(i / 2) * 1000);
          const run = await prisma.run.create({
            data: {
              id: `${id}-${String(i).padStart(3, "0")}`,
              spaceId,
              userId,
              botId: id,
              threadId: id,
              taskId: id,
              status: ["completed", "failed", "cancelled"][i % 3]!,
              trigger: "manual",
              completedAt,
              updatedAt,
            },
          });
          if (name === "main" || name === "group")
            eligible.push({ id: run.id, completedAt, updatedAt });
        }
        for (const [suffix, status, trigger] of [
          ["background-recent", "completed", "tickets"],
          ["background-active", "running", "tickets"],
          ["active", "running", "manual"],
        ] as const)
          await prisma.run.create({
            data: {
              id: `${id}-${suffix}`,
              spaceId,
              userId,
              botId: id,
              threadId: id,
              taskId: id,
              status,
              trigger,
              completedAt: status === "completed" ? new Date("2026-04-01") : null,
              updatedAt: new Date("2026-04-01"),
            },
          });
      }
      await prisma.chatGroupMember.createMany({
        data: ["main", "group"].map((name) => ({ groupId, botId: `${prefix}-${name}` })),
      });
    }),
  );

  afterAll(async () => {
    if (!db) return;
    await system(async () => {
      await db.prisma.organization.deleteMany({ where: { id: organizationId } });
      await db.prisma.user.deleteMany({ where: { id: { in: [actor.userId, otherUser] } } });
    });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps terminal statuses, NULL-first ordering, ties and the twenty-result limit", async () => {
    const expected = [...eligible]
      .sort(
        (a, b) =>
          (a.completedAt === null
            ? b.completedAt === null
              ? 0
              : -1
            : b.completedAt === null
              ? 1
              : b.completedAt.getTime() - a.completedAt.getTime()) ||
          b.updatedAt.getTime() - a.updatedAt.getTime() ||
          b.id.localeCompare(a.id),
      )
      .slice(0, 20);
    const rows = await runAsTenant(actor, () => listSpaceRuns(db.prisma, actor, "recent"));
    expect(rows.map((row) => row.runId)).toEqual(expected.map((row) => row.id));
    expect(rows.map((row) => row.updatedAt)).toEqual(
      expected.map((row) => (row.completedAt ?? row.updatedAt).toISOString()),
    );
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(["completed", "failed", "cancelled"]),
    );
    expect(rows.find((row) => row.groupId === groupId)).toMatchObject({
      groupName: "Team",
      notificationsEnabled: true,
      promptSnippet: "Synthetic group prompt",
    });
    expect(
      rows.filter((row) => row.groupId === null).every((row) => row.notificationsEnabled === false),
    ).toBe(true);
  });

  it("keeps active activity and excludes background work, archived bots and foreign scope", async () => {
    const rows = await runAsTenant(actor, () => listSpaceRuns(db.prisma, actor, "active"));
    expect(rows.map((row) => row.runId).sort()).toEqual(
      [`${prefix}-group-active`, `${prefix}-main-active`].sort(),
    );
    expect(rows.every((row) => row.status === "running" && row.trigger === "manual")).toBe(true);
  });
});
