import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import {
  deleteRunSecretsInTransaction,
  forgetIdleRunSecrets,
  runCodeKind,
  runLoginKind,
  runSecretKind,
} from "./run-secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("run secret cleanup (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `run-secret-owner-${suffix}`;
  const otherId = `run-secret-other-${suffix}`;
  const organizationId = `run-secret-organization-${suffix}`;
  const spaceId = `run-secret-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [ownerId, otherId]) {
      await prisma.user.create({
        data: { id, name: "Run Secret Test", email: `${id}@rakazo.test`, emailVerified: false },
      });
    }
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Run Secret Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", createdByUserId: ownerId },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await close();
  });

  it("removes the run's waiting answer and run-only logins and leaves other rows alone", async () => {
    const rows = [
      { userId: ownerId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runLoginKind("run-1", "example-login") },
      { userId: otherId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runSecretKind("run-2") },
      { userId: ownerId, kind: runLoginKind("run-10", "example-login") },
      { userId: ownerId, kind: "agent-environment" },
    ];
    await prisma.secret.createMany({
      data: rows.map((row) => ({ ...row, spaceId, ciphertext: "fake-ciphertext" })),
    });

    await prisma.$transaction((tx) =>
      deleteRunSecretsInTransaction(tx, [{ id: "run-1", userId: ownerId, spaceId }]),
    );

    const left = await prisma.secret.findMany({
      where: { spaceId },
      select: { userId: true, kind: true },
      orderBy: [{ kind: "asc" }, { userId: "asc" }],
    });
    expect(left).toEqual([
      { userId: ownerId, kind: "agent-environment" },
      { userId: ownerId, kind: runLoginKind("run-10", "example-login") },
      { userId: otherId, kind: runSecretKind("run-1") },
      { userId: ownerId, kind: runSecretKind("run-2") },
    ]);
  });

  it("drops the logins and codes of a run that has waited a day, and keeps everything else", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const old = new Date(now.getTime() - 2 * day);
    const bot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Waiter", color: "blue" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, botId: bot.id, userId: ownerId },
    });
    const run = async (status: "waiting_input" | "running", updatedAt: Date) => {
      const task = await prisma.task.create({
        data: { spaceId, botId: bot.id, threadId: thread.id, userId: ownerId, prompt: "p", status },
      });
      const created = await prisma.run.create({
        data: {
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: ownerId,
          status,
          trigger: "user",
        },
      });
      await prisma.$executeRaw`UPDATE runs SET "updatedAt" = ${updatedAt} WHERE id = ${created.id}`;
      return created.id;
    };
    const idle = await run("waiting_input", old);
    const recent = await run("waiting_input", now);
    const working = await run("running", old);
    const kinds = [
      runLoginKind(idle, "example-login"),
      runCodeKind(idle),
      runLoginKind(recent, "example-login"),
      runLoginKind(working, "example-login"),
    ];
    await prisma.secret.createMany({
      data: kinds.map((kind) => ({
        userId: ownerId,
        spaceId,
        kind,
        ciphertext: "fake-ciphertext",
        createdAt: old,
      })),
    });

    await expect(forgetIdleRunSecrets(prisma, new Date(now.getTime() - day), 100)).resolves.toBe(2);

    const left = await prisma.secret.findMany({
      where: { spaceId, kind: { in: kinds } },
      select: { kind: true },
    });
    expect(left.map((row) => row.kind).sort()).toEqual(
      [runLoginKind(recent, "example-login"), runLoginKind(working, "example-login")].sort(),
    );
  });
});
