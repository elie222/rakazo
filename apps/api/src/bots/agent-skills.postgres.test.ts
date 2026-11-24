import { randomUUID } from "node:crypto";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

describePostgres("renaming a skill under PostgreSQL row-level security", () => {
  it("updates the owner's routines in both spaces for an all-spaces skill", async () => {
    const db = createDb(runtimeUrl!);
    const fixtures = asSystem(db.prisma);
    const organizationId = randomUUID();
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const email = `${userId}@rakazo.test`;
    try {
      await fixtures.user.createMany({
        data: [
          { id: userId, name: "Owner", email },
          { id: otherUserId, name: "Other user", email: `${otherUserId}@rakazo.test` },
        ],
      });
      await fixtures.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          name: "Skill rename",
          createdAt: new Date(),
        },
      });
      const first = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "First" },
      });
      const second = await fixtures.space.create({
        data: { id: randomUUID(), organizationId, name: "Second" },
      });

      async function routine(spaceId: string, userId: string) {
        const bot = await fixtures.bot.create({
          data: { spaceId, userId, name: "Review bot", color: "gray" },
        });
        return fixtures.routine.create({
          data: {
            spaceId,
            userId,
            botId: bot.id,
            name: "Review",
            prompt: "Run @Saved review.",
            crons: [],
          },
        });
      }

      const local = await routine(first.id, userId);
      const remote = await routine(second.id, userId);
      const other = await routine(second.id, otherUserId);
      const actor = { spaceId: first.id, userId, email, isDeploymentOwner: false };
      const publishSpaceChange = vi.fn(async () => undefined);
      const service = createAgentSkillsService(db.prisma, { publishSpaceChange });
      const routineIds = [local.id, remote.id, other.id];

      await runAsTenant(actor, async () => {
        const visible = await db.prisma.routine.findMany({
          where: { id: { in: routineIds } },
          select: { id: true },
        });
        expect(visible).toEqual([{ id: local.id }]);

        const skill = await service.create(actor, {
          name: "Saved review",
          description: "Review steps",
          body: "Read the notes",
        });
        expect(skill.availability?.allSpaces).toBe(true);
        await service.update(actor, { skillId: skill.id, name: "Weekly review" });
      });

      const routines = await fixtures.routine.findMany({
        where: { id: { in: routineIds } },
        select: { id: true, prompt: true },
      });
      expect(Object.fromEntries(routines.map(({ id, prompt }) => [id, prompt]))).toEqual({
        [local.id]: "Run @Weekly review.",
        [remote.id]: "Run @Weekly review.",
        [other.id]: "Run @Saved review.",
      });
      expect(publishSpaceChange).toHaveBeenCalledTimes(2);
      expect(publishSpaceChange).toHaveBeenCalledWith(first.id, "routines");
      expect(publishSpaceChange).toHaveBeenCalledWith(second.id, "routines");
    } finally {
      try {
        await fixtures.organization.deleteMany({ where: { id: organizationId } });
        await fixtures.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
  });
});
