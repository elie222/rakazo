import { randomUUID } from "node:crypto";
import type {
  BackgroundJob,
  MessagingInboundMessage,
  MessagingSurface,
  TeamChatInboundMessage,
} from "@rakazo/adapter-kit";
import { teamChatEngageJobKey } from "@rakazo/adapter-kit";
import { GraphileJobPublisher, MessagingDelivery, TeamChat } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createPool,
  provisionMessagingIdentity,
  runAsSystem,
  sendUserMessage as sendUserMessageTo,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { wakeMessageRoutines } from "./messaging-inbound.js";
import { TeamChatBridge } from "./team-chat-bridge.js";

const databaseUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl && ownerUrl ? describe : describe.skip;

describePostgres("team chat engagement through Graphile jobs (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let owner: ReturnType<typeof createPool>;
  let system: PrismaClient;
  let graphile: GraphileJobPublisher;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const address = `teamchat-${randomUUID()}@example.test`;
  /** Run continuations this process started; the rest go to Graphile. */
  const continued: string[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    owner = createPool(ownerUrl!);
    system = asSystem(db.prisma);
    graphile = new GraphileJobPublisher(db.pool);
    identity = await runAsSystem("teamchat fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    await graphile?.close();
    await owner?.end();
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  const jobs = {
    enqueue: async (job: BackgroundJob) => {
      if (job.name === "run.continue") continued.push(job.payload.runId);
      else await graphile.enqueue(job);
    },
    enqueueIn: (...args: Parameters<GraphileJobPublisher["enqueueIn"]>) =>
      graphile.enqueueIn(...args),
    cancelIn: (...args: Parameters<GraphileJobPublisher["cancelIn"]>) => graphile.cancelIn(...args),
    cancel: (key: string) => graphile.cancel(key),
  };
  const events = {
    sendUserMessage: (input: Parameters<typeof sendUserMessageTo>[1]) =>
      sendUserMessageTo(system, input),
    notify: vi.fn(async () => undefined),
  };

  function teamChat(judge?: ConstructorParameters<typeof TeamChat>[0]["judge"]) {
    return new TeamChat({ prisma: system, events, jobs, judge, ambientDebounceMs: 0 });
  }

  function bridge(chat = teamChat()) {
    return new TeamChatBridge({
      prisma: system,
      teamChat: chat,
      jobs,
      providerId: "slack",
      botId: identity.botId,
    });
  }

  function message(overrides: Partial<TeamChatInboundMessage> = {}): TeamChatInboundMessage {
    return {
      eventId: `Ev-${randomUUID()}`,
      workspaceId: "T-1",
      kind: "mention",
      conversationKey: `channel:C-${identity.botId}`,
      conversationId: "slack:C-1",
      replyThreadId: null,
      senderId: "U-1",
      senderName: "Ada",
      content: "Can you look at the release?",
      ...overrides,
    };
  }

  async function job(key: string) {
    const { rows } = await owner.query<{ run_at: Date; queue_name: string | null }>(
      `select jobs.run_at, queues.queue_name
       from graphile_worker._private_jobs as jobs
       left join graphile_worker._private_job_queues as queues on queues.id = jobs.job_queue_id
       where jobs.key = $1`,
      [key],
    );
    return rows[0];
  }

  function row(id: string) {
    return system.externalMessage.findUniqueOrThrow({ where: { id } });
  }

  it("starts a mention's run in the process that receives it and removes its backup job", async () => {
    const received = await runAsSystem("teamchat mention", () => bridge().receive(message()));
    const recorded = await row(received.externalMessageId);
    expect({
      status: recorded.status,
      continued: continued.includes(recorded.runId!),
      transcript: Boolean(recorded.threadMessageId),
      backup: await job(teamChatEngageJobKey(recorded.id)),
    }).toEqual({ status: "running", continued: true, transcript: true, backup: undefined });
  });

  it("schedules the end of routine routing as a job that hands the message to the agent", async () => {
    const before = Date.now();
    const deferred = await runAsSystem("teamchat routing", () =>
      bridge().receive(message(), { defer: true }),
    );
    expect(deferred.deferred).toBe(true);
    const expiry = await job(teamChatEngageJobKey(deferred.externalMessageId));
    expect(expiry!.run_at.getTime()).toBeGreaterThanOrEqual(before + 2 * 60_000 - 1_000);

    // The process routing it stopped; the job fires when routing's time is up.
    await teamChat().engageJob(deferred.externalMessageId);
    const answered = await row(deferred.externalMessageId);
    expect({ status: answered.status, run: Boolean(answered.runId) }).toEqual({
      status: "running",
      run: true,
    });
    expect(await job(teamChatEngageJobKey(deferred.externalMessageId))).toBeUndefined();
  });

  it("lets only one of a routine wake and the agent answer a deferred message", async () => {
    const routine = await system.routine.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        userId: identity.userId,
        name: "Release desk",
        prompt: "Handle release requests.",
        crons: [],
        active: true,
        messageProvider: "slack",
      },
    });
    try {
      for (let round = 0; round < 3; round += 1) {
        const inbound = message();
        const deferred = await runAsSystem("teamchat routing", () =>
          bridge().receive(inbound, { defer: true }),
        );
        const event = {
          type: "message",
          provider: "slack",
          handle: inbound.eventId,
          threadId: inbound.conversationId,
          isDirect: false,
          from: inbound.senderId,
          fromLabel: inbound.senderName,
          channelName: null,
          participants: [],
          content: inbound.content,
          mediaUrl: null,
        } satisfies MessagingInboundMessage;
        // Routing races the job that fires when its time is up.
        await runAsSystem("teamchat race", () =>
          Promise.all([
            wakeMessageRoutines({ prisma: system, events, jobs }, deferred, event, {
              deliveryProvider: "slack",
              externalMessageId: deferred.externalMessageId,
            }),
            teamChat().engageJob(deferred.externalMessageId),
          ]),
        );
        const settled = await row(deferred.externalMessageId);
        const wakes = await system.message.count({
          where: {
            threadId: deferred.threadId,
            blocks: { array_contains: [{ kind: "delivery" }] },
          },
        });
        const agentRuns = settled.runId ? 1 : 0;
        expect({ answers: agentRuns + (settled.status === "ignored" ? 1 : 0) }).toEqual({
          answers: 1,
        });
        expect(settled.status === "ignored" ? wakes > 0 : true).toBe(true);
      }
    } finally {
      await system.routine.delete({ where: { id: routine.id } });
    }
  });

  it("drops a message for a Space being deleted, keeping its transcript and starting no run", async () => {
    await system.space.update({
      where: { id: identity.spaceId },
      data: {
        deletingAt: new Date(),
        deletionClaimId: `organization-deletion:${identity.spaceId}:x`,
      },
    });
    try {
      const received = await runAsSystem("teamchat deleting", () => bridge().receive(message()));
      const dropped = await row(received.externalMessageId);
      expect({
        status: dropped.status,
        run: dropped.runId,
        transcript: Boolean(dropped.threadMessageId),
        backup: await job(teamChatEngageJobKey(dropped.id)),
      }).toEqual({ status: "ignored", run: null, transcript: true, backup: undefined });
    } finally {
      await system.space.update({
        where: { id: identity.spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }
  });

  it("records a finished run's team-chat reply once and sends it to the thread it came from", async () => {
    const received = await runAsSystem("teamchat reply", () =>
      bridge().receive(message({ replyThreadId: "1700.1" })),
    );
    const { runId } = await row(received.externalMessageId);
    await system.run.update({ where: { id: runId! }, data: { status: "completed" } });
    const thread = await system.thread.findUniqueOrThrow({
      where: { id: received.threadId },
      select: { nextMessageSeq: true },
    });
    await system.message.create({
      data: {
        threadId: received.threadId,
        seq: thread.nextMessageSeq + 100,
        role: "bot",
        botId: identity.botId,
        runId,
        blocks: [{ kind: "text", text: "Release looks good." }],
      },
    });
    const sent: Array<{ threadId: string; body: string }> = [];
    const messaging = {
      platforms: () => [],
      sendToThread: vi.fn(async (request: { threadId: string; body: string }) => {
        sent.push({ threadId: request.threadId, body: request.body });
        return { handle: "1700.2" };
      }),
    } as unknown as MessagingSurface;
    const delivery = () =>
      new MessagingDelivery({
        prisma: system,
        messaging,
        events,
        jobs,
        artifacts: { get: vi.fn() },
      });
    // The finishing process and the run's reply job both deliver it.
    await Promise.all([delivery().deliverRun(runId!), delivery().deliverRun(runId!)]);
    expect(sent).toEqual([{ threadId: "slack:C-1:1700.1", body: "Release looks good." }]);
    expect((await row(received.externalMessageId)).status).toBe("delivered");
  });

  it("decides a quiet conversation's ambient messages in one queued job", async () => {
    const conversationKey = `channel:ambient-${randomUUID()}`;
    const judge = { decide: vi.fn(async () => ({ act: true, reason: "Asked about a date." })) };
    await system.bot.update({
      where: { id: identity.botId },
      data: { teamChatAmbientEnabled: true },
    });
    const chat = teamChat(judge);
    const first = await runAsSystem("teamchat ambient", () =>
      bridge(chat).receive(message({ kind: "ambient", conversationKey, content: "Morning" })),
    );
    const second = await runAsSystem("teamchat ambient", () =>
      bridge(chat).receive(
        message({ kind: "ambient", conversationKey, content: "When does it ship?" }),
      ),
    );
    const { externalConversationId } = await row(first.externalMessageId);
    const decision = await job(`team_chat.ambient:${externalConversationId}`);
    expect(decision?.queue_name).toBe(`team_chat.ambient:${externalConversationId}`);

    await chat.ambientJob(externalConversationId);
    const [morning, question] = [
      await row(first.externalMessageId),
      await row(second.externalMessageId),
    ];
    expect({
      judged: judge.decide.mock.calls.length,
      morning: morning.status,
      question: question.status,
      run: continued.includes(question.runId!),
    }).toEqual({ judged: 1, morning: "ignored", question: "running", run: true });
  });
});
