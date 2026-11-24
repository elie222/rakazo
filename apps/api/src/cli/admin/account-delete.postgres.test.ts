import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;
const run = promisify(execFile);

dbTests("operator account deletion", () => {
  it("previews the target and deletes it with its authentication records after confirmation", async () => {
    const db = createDb(databaseUrl!);
    const prisma = asSystem(db.prisma);
    const id = randomUUID();
    const teammate = randomUUID();
    const email = `${id}@example.test`;
    const cli = (...args: string[]) =>
      run(process.execPath, ["--import", "tsx", "apps/api/src/cli/admin.ts", ...args], {
        env: { ...process.env, WAKEUP_DRIVER: "graphile" },
      });

    try {
      await prisma.user.create({ data: { id, email, name: "Fixture" } });
      const { spaceId } = await bootstrapUserSpace(prisma, { id });
      await prisma.session.create({
        data: { id, userId: id, token: id, expiresAt: new Date(Date.now() + 60_000) },
      });
      await prisma.account.create({
        data: { id, accountId: id, providerId: "credential", userId: id },
      });

      const { organizationId } = await prisma.space.findUniqueOrThrow({ where: { id: spaceId } });
      await prisma.user.create({
        data: { id: teammate, email: `${teammate}@example.test`, name: "Teammate" },
      });
      await prisma.member.create({
        data: {
          id: teammate,
          organizationId,
          userId: teammate,
          role: "member",
          createdAt: new Date(),
        },
      });
      await expect(cli("account", "delete", email, "--confirm")).rejects.toMatchObject({
        code: 1,
        stderr: "Remove the other members of your organization before deleting your account\n",
      });
      expect(await prisma.user.count({ where: { id } })).toBe(1);
      await prisma.member.delete({ where: { id: teammate } });
      const team = await bootstrapUserSpace(prisma, { id: teammate });
      const surviving = await prisma.space.findUniqueOrThrow({ where: { id: team.spaceId } });
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: surviving.organizationId,
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });

      const preview = await cli("account", "delete", email.toUpperCase(), "--json");
      expect(JSON.parse(preview.stdout)).toEqual({ userId: id, deleted: false });
      expect(await prisma.session.count({ where: { id } })).toBe(1);
      expect(await prisma.securityEvent.count({ where: { userId: id } })).toBe(0);

      const confirmed = await cli("account", "delete", email, "--confirm", "--json");
      expect(JSON.parse(confirmed.stdout)).toEqual({ userId: id, deleted: true });
      expect(await prisma.user.count({ where: { id } })).toBe(0);
      expect(await prisma.session.count({ where: { id } })).toBe(0);
      expect(await prisma.account.count({ where: { id } })).toBe(0);
      expect(await prisma.space.count({ where: { id: spaceId } })).toBe(0);
      expect(
        await prisma.securityEvent.findMany({
          where: { userId: id },
          orderBy: { createdAt: "asc" },
        }),
      ).toMatchObject([
        { type: "auth.account.delete_requested", metadata: { by: "operator" } },
        { type: "auth.account.deleted", metadata: { by: "operator" } },
      ]);
      expect(
        await prisma.auditEvent.findMany({
          where: { organizationId: surviving.organizationId, targetId: id },
          orderBy: { createdAt: "asc" },
        }),
      ).toMatchObject([
        { action: "auth.account.delete_requested", actorType: "system", actorLabel: "operator" },
        { action: "auth.account.deleted", actorType: "system", actorLabel: "operator" },
      ]);
    } finally {
      await prisma.auditEvent.deleteMany({ where: { targetType: "user", targetId: id } });
      await prisma.securityEvent.deleteMany({ where: { userId: id } });
      await prisma.organization.deleteMany({
        where: { members: { some: { userId: { in: [id, teammate] } } } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [id, teammate] } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  }, 60_000);
});
