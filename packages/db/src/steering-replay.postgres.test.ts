import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type PrismaClient } from "./client.js";
import { finalizeRun } from "./events.js";
import { expireStuckRun } from "./expire-stuck-run.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("steering after a run ends without completing (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    ({ userId, spaceId, botId, threadId } = identity);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
      await prisma.organization.deleteMany({ where: { id: spaceId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await close?.();
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
        status,
        trigger: "user",
        startedAt: new Date(),
        leaseOwner: status === "running" ? "worker-1" : null,
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
        claimedAt: new Date(),
      },
    });
    return { task, run, attempt };
  }

  async function botReplies(runId: string) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await createThreadMessage(prisma, {
      threadId,
      role: "bot",
      botId,
      runId,
      blocks: [{ kind: "text", text: "Yes, I can pull the documents myself." }],
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

    expect(await prisma.run.count({ where: { threadId, trigger: "follow_up" } })).toBe(0);
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
