import type { MessageBlock } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem, runAsTenant } from "../database/row-security.js";
import { readHistory } from "../history/history-retrieval.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { clearThread } from "../threads/events.js";
import {
  createToolCallRecord,
  deleteExpiredToolCallRecords,
  runToolCallRecords,
  setSpaceKeepsToolCallRecords,
  spaceKeepsToolCallRecords,
} from "./tool-call-records.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("tool call records (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let otherSpaceId: string;
  let otherUserId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const otherAddress = `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  const asOwner = <T>(work: () => Promise<T>) => runAsTenant({ spaceId, userId }, work);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "sendblue", address }),
    ));
    ({ userId: otherUserId, spaceId: otherSpaceId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "sendblue", address: otherAddress }),
    ));
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        for (const identity of [
          { provider: "sendblue", address },
          { provider: "sendblue", address: otherAddress },
        ]) {
          await system.messagingIdentity.deleteMany({ where: identity });
        }
        await system.organization.deleteMany({ where: { id: { in: [spaceId, otherSpaceId] } } });
        await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
      }
    } finally {
      await close?.();
    }
  });

  /** One run of this chat, started from a message of its own. */
  async function runFrom(sourceMessageId: string): Promise<string> {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "read the inbox", status: "running" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "completed",
        trigger: "user",
        sourceMessageId,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    return run.id;
  }

  async function message(text: string): Promise<string> {
    const { nextMessageSeq } = await system.thread.update({
      where: { id: threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    const blocks: MessageBlock[] = [{ kind: "text", text }];
    const created = await system.message.create({
      data: { threadId, botId, seq: nextMessageSeq - 1, role: "user", blocks },
    });
    return created.id;
  }

  function trace(runId: string, executionId: string, extra: { arguments?: string } = {}) {
    return {
      spaceId,
      threadId,
      botId,
      runId,
      executionId,
      tool: "mail_execute",
      durationMs: 1200,
      outcome: "failed" as const,
      arguments: extra.arguments ?? '{"query":"in:inbox"}',
      error: "401 Unauthorized",
      resultBytes: 4096,
      resultShortened: true,
      resultHead: "denied for this mailbox",
    };
  }

  it("keeps a call's trace where the Space's own reader finds it", async () => {
    const runId = await runFrom(await message("check the inbox"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-1")));

    const [kept] = await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }));
    expect(kept).toEqual({
      executionId: "exec-1",
      tool: "mail_execute",
      durationMs: 1200,
      outcome: "failed",
      arguments: '{"query":"in:inbox"}',
      error: "401 Unauthorized",
      resultBytes: 4096,
      resultShortened: true,
      resultHead: "denied for this mailbox",
    });
  });

  it("shows another Space nothing", async () => {
    const runId = await runFrom(await message("check the outbox"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-2")));

    expect(
      await runAsTenant({ spaceId: otherSpaceId, userId: otherUserId }, () =>
        runToolCallRecords(prisma, { spaceId, runId }),
      ),
    ).toEqual([]);
  });

  it("deletes what is past the 14 days and keeps the rest", async () => {
    const runId = await runFrom(await message("check both"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "old")));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "fresh")));
    await system.toolCallRecord.updateMany({
      where: { runId, executionId: "old" },
      data: { createdAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) },
    });

    const deleted = await runAsSystem("expire tool call records", () =>
      deleteExpiredToolCallRecords(prisma),
    );
    expect(deleted).toBe(1);
    const left = await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }));
    expect(left.map((call) => call.executionId)).toEqual(["fresh"]);
  });

  it("keeps no record longer than a shorter chat history retention", async () => {
    const runId = await runFrom(await message("short history"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "three-days")));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "today")));
    await system.toolCallRecord.updateMany({
      where: { runId, executionId: "three-days" },
      data: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) },
    });

    const deleted = await runAsSystem("expire tool call records", () =>
      deleteExpiredToolCallRecords(prisma, { chatHistoryDays: 2 }),
    );
    expect(deleted).toBe(1);
    const left = await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }));
    expect(left.map((call) => call.executionId)).toEqual(["today"]);
  });

  it("stops between batches once the sweep is aborted", async () => {
    const runId = await runFrom(await message("stopping"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "old")));
    await system.toolCallRecord.updateMany({
      where: { runId },
      data: { createdAt: new Date(Date.now() - 15 * 24 * 60 * 60_000) },
    });

    const deleted = await runAsSystem("expire tool call records", () =>
      deleteExpiredToolCallRecords(prisma, { signal: AbortSignal.abort() }),
    );
    expect(deleted).toBe(0);
  });

  it("takes a cleared conversation's records with it", async () => {
    const runId = await runFrom(await message("clear me"));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-3")));

    await asOwner(() => clearThread(prisma, { spaceId, threadId, botId }));
    expect(await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }))).toEqual([]);
  });

  it("keeps nothing of a call that finishes after its run was cancelled", async () => {
    const runId = await runFrom(await message("stop that"));
    await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "late-call")));
    expect(await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }))).toEqual([]);
  });

  it("gives a bot the details of the run it linked, and no other", async () => {
    const sourceMessageId = await message("why did that fail");
    const runId = await runFrom(sourceMessageId);
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-4")));
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-5")));
    const scope = { spaceId, threadId, botId, toolDetailsUserId: userId };
    const calls = async (linkedRunId: string) =>
      (
        await asOwner(() => readHistory(prisma, scope, { messageId: sourceMessageId, linkedRunId }))
      ).runs.flatMap((run) => ("toolCalls" in run ? [run.toolCalls] : []));

    expect(await calls(runId)).toHaveLength(1);
    // The model can name any run id; one this page did not reach explains nothing.
    expect(await calls("run-not-on-this-page")).toEqual([]);
  });

  it("explains a run's own calls only to the person who started it", async () => {
    const sourceMessageId = await message("what went wrong here");
    const runId = await runFrom(sourceMessageId);
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-6")));
    const page = { messageId: sourceMessageId, linkedRunId: runId };

    const mine = await asOwner(() =>
      readHistory(prisma, { spaceId, threadId, botId, toolDetailsUserId: userId }, page),
    );
    expect(mine.runs.some((run) => "toolCalls" in run)).toBe(true);
    // The starter's id gates the read; a bot never sees it on any run of the page.
    expect(mine.runs.every((run) => !("userId" in run))).toBe(true);

    // The same page read for another member of the Space explains nothing of this run.
    const theirs = await asOwner(() =>
      readHistory(prisma, { spaceId, threadId, botId, toolDetailsUserId: otherUserId }, page),
    );
    expect(theirs.runs.some((run) => "toolCalls" in run)).toBe(false);
  });

  it("keeps the calls that need explaining when later ones worked", async () => {
    const sourceMessageId = await message("fail then work");
    const runId = await runFrom(sourceMessageId);
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "failed-call")));
    // A call waiting on a person needs no explanation and takes none of the slots.
    await asOwner(() =>
      createToolCallRecord(prisma, {
        ...trace(runId, "paused-call"),
        outcome: "paused",
        error: undefined,
        resultShortened: false,
        resultHead: undefined,
      }),
    );
    for (let i = 0; i < 14; i += 1) {
      await asOwner(() =>
        createToolCallRecord(prisma, {
          ...trace(runId, `ok-${i}`),
          outcome: "succeeded",
          error: undefined,
          resultShortened: false,
          resultHead: undefined,
        }),
      );
    }

    const newest = await asOwner(() => runToolCallRecords(prisma, { spaceId, runId }));
    expect(newest.some((call) => call.executionId === "failed-call")).toBe(false);
    const explained = await asOwner(() =>
      runToolCallRecords(prisma, { spaceId, runId, explainedOnly: true }),
    );
    expect(explained.map((call) => call.executionId)).toEqual(["failed-call"]);

    // The bot asking why gets the same failure, not the four newest calls that worked.
    const page = await asOwner(() =>
      readHistory(
        prisma,
        { spaceId, threadId, botId, toolDetailsUserId: userId },
        { messageId: sourceMessageId, linkedRunId: runId },
      ),
    );
    const linked = page.runs.find((run) => run.id === runId);
    expect(
      (linked && "toolCalls" in linked ? linked.toolCalls : [])?.map((call) => call.executionId),
    ).toEqual(["failed-call"]);
  });

  it("explains nothing to a read that names no starter", async () => {
    const sourceMessageId = await message("no starter here");
    const runId = await runFrom(sourceMessageId);
    // A read whose source allows no details names no starter, and nothing matches that.
    await asOwner(() => createToolCallRecord(prisma, trace(runId, "exec-7")));
    const page = await asOwner(() =>
      readHistory(
        prisma,
        { spaceId, threadId, botId },
        { messageId: sourceMessageId, linkedRunId: runId },
      ),
    );
    expect(page.runs.some((run) => "toolCalls" in run)).toBe(false);
  });

  it("keeps records for a Space by default and stops when it says so", async () => {
    expect(await spaceKeepsToolCallRecords(prisma, spaceId)).toBe(true);
    await setSpaceKeepsToolCallRecords(prisma, spaceId, false);
    expect(await spaceKeepsToolCallRecords(prisma, spaceId)).toBe(false);
    await setSpaceKeepsToolCallRecords(prisma, spaceId, true);
  });
});
