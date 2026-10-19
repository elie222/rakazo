import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { claimSteering, createPendingSteeringRun, finalizeRun, sendUserMessage } from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("steering after a run ends without completing (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    ({ userId, spaceId, botId, threadId } = identity);
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await prisma.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await prisma.organization.deleteMany({ where: { id: spaceId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  async function runSteeredByMessage(status: "running" | "waiting_input") {
    await prisma.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "collect documents", status },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const steeringText = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `done ${randomUUID()}` }],
    });
    await prisma.steeringMessage.create({
      data: {
        messageId: steeringText.id,
        botId,
        userId,
        runId: run.id,
      },
    });
    await claimSteering(prisma, {
      threadId,
      botId,
      runId: run.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      seenIds: [],
    });
    if (status === "waiting_input") {
      await prisma.run.update({ where: { id: run.id }, data: { status, leaseOwner: null } });
    }
    return { task, run, attempt };
  }

  async function botReplies(runId: string, clientNonce?: string) {
    await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId,
      blocks: [{ kind: "text", text: "Yes, I can pull the documents myself." }],
      clientNonce,
    });
  }

  function failRun(fixture: Awaited<ReturnType<typeof runSteeredByMessage>>) {
    return finalizeRun(prisma, {
      spaceId,
      threadId,
      botId,
      runId: fixture.run.id,
      taskId: fixture.task.id,
      attemptId: fixture.attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "failed",
      error: "stream idle timeout",
    });
  }

  it("does not answer a message again after the failed run already replied to it", async () => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id);

    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });

    expect(await prisma.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(0);
  });

  it("still continues a message the failed run claimed but never replied to", async () => {
    const fixture = await runSteeredByMessage("running");

    const result = await failRun(fixture);

    expect(result).toEqual({ continuationRunId: expect.any(String) });
    const continuation = await prisma.run.findUniqueOrThrow({
      where: { id: (result as { continuationRunId: string }).continuationRunId },
    });
    expect(continuation.trigger).toBe("follow_up");
  });

  it("does not replay a claimed request after a progress update or promoted narration", async () => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id, `user-progress:${fixture.run.id}:0:test`);
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });
  });

  it.each([0, 60_000])("ignores a claim clock offset of %i ms", async (offset) => {
    const fixture = await runSteeredByMessage("running");
    await botReplies(fixture.run.id);
    const reply = await prisma.message.findFirstOrThrow({ where: { runId: fixture.run.id } });
    await prisma.steeringMessage.updateMany({
      where: { runId: fixture.run.id },
      data: { claimedAt: new Date(reply.createdAt.getTime() + offset) },
    });
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: null });
    expect(await prisma.steeringMessage.count({ where: { runId: fixture.run.id } })).toBe(0);
  });

  it("replays a message claimed after a reply even when the user message preceded it", async () => {
    const fixture = await runSteeredByMessage("running");
    const message = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: "A second request" }],
    });
    const steering = await prisma.steeringMessage.create({
      data: { messageId: message.id, botId, userId, runId: fixture.run.id },
    });
    await botReplies(fixture.run.id);
    await claimSteering(prisma, {
      threadId,
      botId,
      runId: fixture.run.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      seenIds: (
        await prisma.steeringMessage.findMany({
          where: { runId: fixture.run.id, id: { not: steering.id } },
          select: { id: true },
        })
      ).map((item) => item.id),
    });
    await expect(failRun(fixture)).resolves.toEqual({ continuationRunId: expect.any(String) });
    expect(await prisma.steeringMessage.findUnique({ where: { id: steering.id } })).not.toBeNull();
  });

  it("never releases a chat message that steered an app run as an app follow-up", async () => {
    const { task, run, attempt } = await runSteeredByMessage("running");
    const inbound = await sendUserMessage(prisma, {
      spaceId,
      threadId,
      botId,
      userId,
      blocks: [{ kind: "text", text: "Rewrite your child's instructions" }],
      prompt: "Rewrite your child's instructions",
      trigger: "messaging",
    });
    expect(inbound.runId).toBe(run.id);

    const result = await finalizeRun(prisma, {
      spaceId,
      threadId,
      botId,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      outcome: "completed",
      blocks: [{ kind: "text", text: "Done." }],
    });

    expect(result).toEqual({ continuationRunId: expect.any(String) });
    const continuation = await prisma.run.findUniqueOrThrow({
      where: { id: (result as { continuationRunId: string }).continuationRunId },
    });
    expect(continuation.sourceMessageId).toBe(inbound.messageId);
    expect(continuation.trigger).toBe("messaging");
  });

  it("keeps a private batch with a direct-line message a messaging run, even when the app wrote last", async () => {
    await prisma.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await prisma.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const directLine = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `Rewrite your child's instructions ${randomUUID()}` }],
    });
    const app = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [{ kind: "text", text: `And thanks ${randomUUID()}` }],
    });
    const rows = await Promise.all([
      prisma.steeringMessage.create({
        data: { messageId: directLine.id, botId, userId, originTrigger: "messaging" },
      }),
      prisma.steeringMessage.create({ data: { messageId: app.id, botId, userId } }),
    ]);

    const continuationRunId = await prisma.$transaction((tx) =>
      createPendingSteeringRun(tx, { spaceId, threadId, botId }),
    );

    const continuation = await prisma.run.findUniqueOrThrow({ where: { id: continuationRunId! } });
    expect(continuation).toMatchObject({ trigger: "messaging", sourceMessageId: app.id });
    expect(
      await prisma.steeringMessage.count({
        where: { id: { in: rows.map((row) => row.id) }, runId: continuationRunId },
      }),
    ).toBe(2);
  });

  it("keeps a channel message queued before origins were recorded a messaging run", async () => {
    await prisma.run.updateMany({
      where: { threadId, status: { in: ["queued", "running", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    await prisma.steeringMessage.deleteMany({ where: { botId, runId: null } });
    const legacy = await createThreadMessage(prisma, {
      threadId,
      role: "user",
      blocks: [
        {
          kind: "channel_message",
          provider: "sendblue",
          channelId: randomUUID(),
          fromAddress: "+15550000000",
          fromLabel: "Guest",
          text: `Rewrite your child's instructions ${randomUUID()}`,
        },
      ],
    });
    await prisma.steeringMessage.create({ data: { messageId: legacy.id, botId, userId } });

    const continuationRunId = await prisma.$transaction((tx) =>
      createPendingSteeringRun(tx, { spaceId, threadId, botId }),
    );

    const continuation = await prisma.run.findUniqueOrThrow({ where: { id: continuationRunId! } });
    expect(continuation.trigger).toBe("messaging");
  });

  it("does not answer a message again after an expired wait that already replied to it", async () => {
    const fixture = await runSteeredByMessage("waiting_input");
    await botReplies(fixture.run.id);
    const { updatedAt } = await prisma.run.findUniqueOrThrow({ where: { id: fixture.run.id } });

    const expired = await prisma.$transaction((tx) =>
      expireStuckRun(tx, {
        runId: fixture.run.id,
        threadId,
        status: "waiting_input",
        updatedAt,
        now: new Date(),
      }),
    );

    expect(expired).toMatchObject({ continuationRunId: null });
  });
});
