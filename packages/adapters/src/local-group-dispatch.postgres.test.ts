import { randomUUID } from "node:crypto";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { advanceGroupTeam, peerJobNonce } from "./local-group-dispatch.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("group fanout across independent PostgreSQL workers", () => {
  const address = `group-fanout-${randomUUID()}@rakazo.test`;
  let first: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let actor: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let groupThreadId: string;
  let rootBotId: string;
  let peerIds: string[];

  beforeAll(async () => {
    first = createDb(databaseUrl!);
    second = createDb(databaseUrl!);
    actor = await runAsSystem("group fanout test fixture", () =>
      provisionMessagingIdentity(
        first.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const db = asSystem(first.prisma);
    rootBotId = actor.botId;
    const peers = await Promise.all(
      ["Critic", "Fact checker"].map((name) =>
        db.bot.create({
          data: { spaceId: actor.spaceId, userId: actor.userId, name, color: "#123456" },
        }),
      ),
    );
    peerIds = peers.map((bot) => bot.id);
    const group = await db.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Independent reviews",
        members: {
          create: [rootBotId, ...peerIds].map((botId) => ({ botId })),
        },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    groupThreadId = group.thread!.id;
  });

  afterAll(async () => {
    if (actor) {
      const db = asSystem(first.prisma);
      await db.messagingIdentity.deleteMany({ where: { address } });
      await db.organization.deleteMany({ where: { id: actor.spaceId } });
      await db.user.deleteMany({ where: { id: actor.userId } });
    }
    for (const db of [first, second]) {
      if (!db) continue;
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("fanouts and synthesizes exactly once when competing workers observe the same completion", async () => {
    const db = asSystem(first.prisma);
    const message = await db.message.create({
      data: {
        threadId: groupThreadId,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: "Cross-check this estimate" }],
      },
    });
    const task = await db.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: rootBotId,
        threadId: groupThreadId,
        status: "completed",
        prompt: "Cross-check this estimate",
      },
    });
    const root = await db.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: rootBotId,
        threadId: groupThreadId,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        sourceMessageId: message.id,
        completedAt: new Date(),
      },
    });

    const firstPublisher = { enqueue: vi.fn(async () => {}) };
    const secondPublisher = { enqueue: vi.fn(async () => {}) };
    const deps1 = { prisma: asSystem(first.prisma), jobs: firstPublisher };
    const deps2 = { prisma: asSystem(second.prisma), jobs: secondPublisher };
    await Promise.all([
      advanceGroupTeam(deps1 as never, root.id),
      advanceGroupTeam(deps2 as never, root.id),
    ]);
    const peerRuns = await db.run.findMany({
      where: {
        spaceId: actor.spaceId,
        clientNonce: { startsWith: `local-group-team:${root.id}:` },
      },
    });
    expect(peerRuns).toHaveLength(2);
    expect(peerRuns.map((run) => run.clientNonce).sort()).toEqual(
      peerIds.map((botId) => peerJobNonce(root.id, botId)).sort(),
    );
    expect(
      firstPublisher.enqueue.mock.calls.length + secondPublisher.enqueue.mock.calls.length,
    ).toBe(2);
    expect(
      (await db.run.findUniqueOrThrow({ where: { id: root.id } })).groupReviewScheduledAt,
    ).toBeInstanceOf(Date);

    // Membership changes while reviewers are active must not add a phantom wait.
    const extra = await db.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Late joiner", color: "#654321" },
    });
    const groupId = (await db.thread.findUniqueOrThrow({ where: { id: groupThreadId } })).groupId!;
    await db.chatGroupMember.create({ data: { groupId, botId: extra.id } });
    await db.run.updateMany({
      where: { id: { in: peerRuns.map((run) => run.id) } },
      data: { status: "completed", completedAt: new Date() },
    });
    await Promise.all([
      advanceGroupTeam(deps1 as never, peerRuns[0]!.id),
      advanceGroupTeam(deps2 as never, peerRuns[1]!.id),
    ]);
    const syntheses = await db.run.findMany({
      where: { spaceId: actor.spaceId, clientNonce: `local-agent-goal:${root.id}:1` },
    });
    expect(syntheses).toHaveLength(1);
    expect(syntheses[0]?.botId).toBe(rootBotId);
    expect(
      firstPublisher.enqueue.mock.calls.length + secondPublisher.enqueue.mock.calls.length,
    ).toBe(3);
  });
});
