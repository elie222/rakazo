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

      const preview = await cli("account", "delete", email.toUpperCase(), "--json");
      expect(JSON.parse(preview.stdout)).toEqual({ userId: id, deleted: false });
      expect(await prisma.session.count({ where: { id } })).toBe(1);

      const confirmed = await cli("account", "delete", email, "--confirm", "--json");
      expect(JSON.parse(confirmed.stdout)).toEqual({ userId: id, deleted: true });
      expect(await prisma.user.count({ where: { id } })).toBe(0);
      expect(await prisma.session.count({ where: { id } })).toBe(0);
      expect(await prisma.account.count({ where: { id } })).toBe(0);
      expect(await prisma.space.count({ where: { id: spaceId } })).toBe(0);
      expect(await prisma.securityEvent.findFirst({ where: { userId: id } })).toMatchObject({
        type: "auth.account.deleted",
        metadata: { by: "operator" },
      });
    } finally {
      await prisma.securityEvent.deleteMany({ where: { userId: id } });
      await prisma.organization.deleteMany({ where: { members: { some: { userId: id } } } });
      await prisma.user.deleteMany({ where: { id: { in: [id, teammate] } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  }, 60_000);
});
