import { randomUUID } from "node:crypto";
import type { MessageBlock, ToolQuestion } from "@rakazo/contracts";
import { answerToolQuestion, createDb, createThreadEvents, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "../../notifications/realtime.js";
import type { RunContext } from "../assembly/run-context.js";
import { withRunLease } from "../assembly/run-messages.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { toolAskFor } from "./run-tool-questions.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const QUESTION: ToolQuestion = {
  source: "Gateway",
  message: "Allow send_email to run?",
  fields: [{ name: "approve", label: "Approve", required: true, type: "boolean" }],
};

postgres("a tool's question in a running run (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const id = `tool-question-${randomUUID()}`;
  const spaceId = `${id}-space`;
  const userId = `${id}-user`;
  const organizationId = `${id}-org`;
  const fixture = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  // Two API instances: the one holding the call and the one the answer reaches. They share
  // only the database and the realtime fanout, as two processes do.
  const realtime = new InMemoryRealtimeFanout();
  let run: { id: string; spaceId: string; userId: string; threadId: string; botId: string };

  beforeAll(async () => {
    run = await fixture(async () => {
      await prisma.user.create({ data: { id: userId, name: "Asker", email: `${id}@rakazo.test` } });
      await prisma.organization.create({
        data: { id: organizationId, name: "Question tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Question tests" } });
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: "Asker",
          color: "ink",
          thread: { create: { spaceId, userId } },
        },
        include: { thread: true },
      });
      const threadId = bot.thread!.id;
      const task = await prisma.task.create({
        data: { spaceId, userId, botId: bot.id, threadId, prompt: "Send it", status: "running" },
      });
      return prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          status: "running",
          trigger: "user",
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
        select: { id: true, spaceId: true, userId: true, threadId: true, botId: true },
      });
    });
  });

  afterAll(async () => {
    try {
      await fixture(async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  });

  function runContext(
    source: { ownerStartedRun: boolean; messagingChannelRun: boolean },
    signal = new AbortController().signal,
  ) {
    const deps = withRunLease(
      // A slow safety-net re-read: only the realtime signal can wake the wait in time.
      {
        prisma,
        events: createThreadEvents(prisma, realtime, { catchUpMs: 600_000 }),
      } as unknown as ExecutorDeps,
      run.id,
      { owner: "worker-1", fence: 1 },
    );
    return {
      deps,
      run: { ...run, trigger: "user" },
      runId: run.id,
      bot: { id: run.botId, name: "Asker" },
      thread: { id: run.threadId, groupId: null },
      context: { spaceId, userId, runId: run.id, signal },
      source,
    } as unknown as RunContext;
  }

  const pendingCard = () =>
    fixture(async () => {
      const message = await prisma.message.findFirst({
        where: { runId: run.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      const block = (message?.blocks as MessageBlock[] | undefined)?.[0];
      return block?.kind === "tool_question" && block.status === "pending" ? message : null;
    });

  const card = (messageId: string) =>
    fixture(async () => {
      const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
      return (message.blocks as MessageBlock[])[0];
    });

  it("waits in the call for an answer given through another instance", async () => {
    const ask = toolAskFor(runContext({ ownerStartedRun: true, messagingChannelRun: false }))!;
    const answer = runAsSystem("agent run tool call", () =>
      ask(QUESTION, new AbortController().signal),
    );
    const posted = await vi.waitFor(async () => {
      const message = await pendingCard();
      if (!message) throw new Error("no card yet");
      return message;
    });
    const otherInstance = createThreadEvents(prisma, realtime);
    const committed = await fixture(() =>
      answerToolQuestion(prisma, {
        spaceId,
        threadId: run.threadId,
        messageId: posted.id,
        userId,
        action: "accept",
        values: { approve: true },
      }),
    );
    await otherInstance.notify(committed!.threadId, committed!.seq);
    expect(await answer).toEqual({ action: "accept", values: { approve: true } });
    expect(await card(posted.id)).toMatchObject({ status: "accepted" });
    expect(await card(posted.id)).not.toHaveProperty("sealedValues");
  });

  it("closes the card as expired when the call stops waiting", async () => {
    const stop = new AbortController();
    const ask = toolAskFor(runContext({ ownerStartedRun: true, messagingChannelRun: false }))!;
    const answer = runAsSystem("agent run tool call", () => ask(QUESTION, stop.signal));
    const posted = await vi.waitFor(async () => {
      const message = await pendingCard();
      if (!message) throw new Error("no card yet");
      return message;
    });
    // The server withdrew the question, the run was stopped or the wait ran out.
    stop.abort();
    expect(await answer).toEqual({ action: "cancel" });
    expect(await card(posted.id)).toMatchObject({ status: "expired" });
  });

  it("has nobody to ask in runs the person did not start in the app", () => {
    expect(toolAskFor(runContext({ ownerStartedRun: false, messagingChannelRun: false }))).toBe(
      undefined,
    );
    expect(toolAskFor(runContext({ ownerStartedRun: true, messagingChannelRun: true }))).toBe(
      undefined,
    );
  });
});
