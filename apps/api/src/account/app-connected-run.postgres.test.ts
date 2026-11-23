import { randomUUID } from "node:crypto";
import type { ConnectorRegistry } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { appConnectCard } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createDb, createThreadMessageInTransaction, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { markAppConnected } from "./onboarding.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const app = {
  connectorId: "catalog",
  slug: "slack",
  name: "Slack",
  logo: null,
  connected: false,
  noAuth: false,
};

describe.skipIf(!enabled)("connecting an app from a bot's card (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  const suffix = randomUUID();
  const organizationId = `app-connected-org-${suffix}`;
  const connectors = {
    defaultConnectorId: "catalog",
    managed: () => ({ catalog: async () => [{ ...app, connected: true }] }),
  } as unknown as ConnectorRegistry;

  beforeAll(() =>
    runAsSystem("app connected fixture", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = db.prisma;
      const userId = `app-connected-user-${suffix}`;
      const spaceId = `app-connected-space-${suffix}`;
      await prisma.user.create({
        data: { id: userId, name: "Connect", email: `${userId}@example.test`, emailVerified: true },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Connect", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({
        data: { id: spaceId, organizationId, name: "General", createdByUserId: userId },
      });
      actor = { spaceId, userId, email: `${userId}@example.test`, isDeploymentOwner: false };
    }),
  );
  afterAll(() =>
    runAsSystem("app connected fixture", async () => {
      if (!prisma) return;
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: actor?.userId } });
      await prisma.$disconnect();
      await db.pool.end();
    }),
  );

  /** A bot whose finished run asked for Slack, beside an onboarding card that no run posted. */
  async function chat() {
    return runAsSystem("app connected fixture", async () => {
      const bot = await prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Helper",
          color: "ink",
          thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
        },
        include: { thread: true },
      });
      const threadId = bot.thread!.id;
      const task = await prisma.task.create({
        data: {
          spaceId: actor.spaceId,
          botId: bot.id,
          threadId,
          userId: actor.userId,
          prompt: "Summarize my Slack",
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId: actor.spaceId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "completed",
          trigger: "user",
        },
      });
      const blocks: MessageBlock[] = [appConnectCard(app)];
      const [onboarding, card] = await prisma.$transaction(async (tx) => [
        await createThreadMessageInTransaction(tx, { threadId, role: "bot", blocks }),
        await createThreadMessageInTransaction(tx, {
          threadId,
          botId: bot.id,
          runId: run.id,
          role: "bot",
          blocks,
        }),
      ]);
      return { botId: bot.id, threadId, cardRunId: run.id, onboarding, card };
    });
  }
  const followUps = (threadId: string, cardRunId: string) =>
    runAsSystem("app connected fixture", () =>
      prisma.run.findMany({ where: { threadId, id: { not: cardRunId } }, include: { task: true } }),
    );
  const connect = (
    jobs: { enqueue: () => Promise<void> },
    botId: string,
    threadId: string,
    messageId: string,
  ) =>
    runAsTenant(actor, () =>
      markAppConnected(
        { prisma, events: { notify: vi.fn() }, connectors, jobs } as never,
        actor,
        botId,
        "slack",
        "catalog",
        threadId,
        messageId,
      ),
    );

  it("starts one follow-up run when the run's card connects, however often it is reported", async () => {
    const { botId, threadId, cardRunId, card } = await chat();
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await Promise.all([
      connect(jobs, botId, threadId, card.id),
      connect(jobs, botId, threadId, card.id),
    ]);
    await connect(jobs, botId, threadId, card.id);

    const runs = await followUps(threadId, cardRunId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ botId, status: "queued", trigger: "user" });
    expect(runs[0]?.task.prompt).toContain('"Slack"');
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when the card connected from is onboarding's", async () => {
    const { botId, threadId, cardRunId, onboarding } = await chat();
    const jobs = { enqueue: vi.fn(async () => undefined) };

    await connect(jobs, botId, threadId, onboarding.id);

    expect(await followUps(threadId, cardRunId)).toHaveLength(0);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});
