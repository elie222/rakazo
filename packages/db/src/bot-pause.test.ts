import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as Events from "./events.js";
import type * as Messages from "./messages.js";

vi.mock("./events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Events>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));
vi.mock("./messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Messages>()),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "message-1", seq: 1 })),
}));
vi.mock("./cancel-runs.js", () => ({
  cancelRunsInTransaction: vi.fn(async (_tx: unknown, runs: unknown[]) => runs),
}));
vi.mock("./audit-events.js", () => ({ recordAuditEvent: vi.fn(async () => {}) }));

import { recordAuditEvent } from "./audit-events.js";
import { BotPausedError, pauseBot, resumeBot } from "./bot-pause.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { sendUserMessage } from "./events.js";
import { SpaceOwnerRequiredError } from "./space-members.js";

const actor = (userId: string): Actor => ({
  spaceId: "space-1",
  userId,
  email: `${userId}@example.test`,
  isDeploymentOwner: false,
});

function fakeDb(roles: Record<string, string> = {}) {
  const bot = { id: "bot-1", name: "Helper", userId: "owner", pausedAt: null as Date | null };
  const run = {
    id: "run-1",
    taskId: "task-1",
    userId: "owner",
    spaceId: "space-1",
    threadId: "thread-1",
  };
  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { pausedAt: null | object };
      data: { pausedAt: Date | null };
    }) => {
      if ((where.pausedAt === null) !== (bot.pausedAt === null)) return { count: 0 };
      bot.pausedAt = data.pausedAt;
      return { count: 1 };
    },
  );
  const memberLookup = () => ({
    findUnique: vi.fn(async ({ where }: { where: { spaceId_userId: { userId: string } } }) => {
      const role = roles[where.spaceId_userId.userId];
      return role ? { role } : null;
    }),
  });
  const tx = {
    $queryRaw: vi.fn(async () => (bot.pausedAt ? [{ id: bot.id, pausedAt: bot.pausedAt }] : [])),
    space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
    bot: {
      findUnique: vi.fn(async () => ({ pausedAt: bot.pausedAt })),
      findFirst: vi.fn(async () => bot),
      updateMany,
    },
    spaceMember: memberLookup(),
    run: { findMany: vi.fn(async () => [run]) },
    computer: { updateMany: vi.fn() },
    steeringMessage: { deleteMany: vi.fn() },
    event: { deleteMany: vi.fn() },
    computerExecutionLease: { updateMany: vi.fn() },
  };
  const prisma = {
    bot: {
      findFirst: vi.fn(async () => bot),
      updateMany,
    },
    spaceMember: memberLookup(),
    message: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return { bot, tx, prisma: prisma as unknown as PrismaClient, notify: vi.fn(async () => {}) };
}

const send = (prisma: PrismaClient) =>
  sendUserMessage(prisma, {
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    userId: "owner",
    blocks: [{ kind: "text", text: "hi" }],
    prompt: "hi",
    trigger: "user",
  });

describe("pauseBot", () => {
  it("pauses, cancels the active runs and records who did it", async () => {
    const { bot, tx, prisma, notify } = fakeDb();
    const cancelled = await pauseBot(prisma, { notify }, actor("owner"), "bot-1");
    expect(bot.pausedAt).toBeInstanceOf(Date);
    expect(cancelled.map((run) => run.id)).toEqual(["run-1"]);
    // Every waiting message of the bot goes, not only those in a thread with a run.
    expect(tx.steeringMessage.deleteMany).toHaveBeenCalledWith({ where: { botId: "bot-1" } });
    expect(tx.event.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ runId: { in: ["run-1"] } }),
    });
    expect(cancelRunsInTransaction).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("thread-1", 7);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bot.paused",
        actor: { type: "user", id: "owner" },
        target: { type: "bot", id: "bot-1", label: "Helper" },
      }),
    );
  });

  it("lets the space owner pause but refuses another member", async () => {
    const { prisma, notify } = fakeDb({ boss: "owner", peer: "member" });
    await expect(pauseBot(prisma, { notify }, actor("peer"), "bot-1")).rejects.toBeInstanceOf(
      SpaceOwnerRequiredError,
    );
    await expect(pauseBot(prisma, { notify }, actor("stranger"), "bot-1")).rejects.toBeInstanceOf(
      SpaceOwnerRequiredError,
    );
    await expect(pauseBot(prisma, { notify }, actor("boss"), "bot-1")).resolves.toHaveLength(1);
  });
});

describe("pauseBot authorization", () => {
  it("checks the owner again inside the transaction that writes", async () => {
    const { bot, tx, prisma, notify } = fakeDb({ boss: "owner" });
    // The role is revoked after the first read: only a check made in the write's transaction sees it.
    tx.spaceMember.findUnique.mockResolvedValue(null as never);
    await expect(pauseBot(prisma, { notify }, actor("boss"), "bot-1")).rejects.toBeInstanceOf(
      SpaceOwnerRequiredError,
    );
    expect(bot.pausedAt).toBeNull();
    await expect(resumeBot(prisma, actor("boss"), "bot-1")).rejects.toBeInstanceOf(
      SpaceOwnerRequiredError,
    );
  });

  it("finishes a cancellation that failed, and records the pause once", async () => {
    const { bot, tx, prisma, notify } = fakeDb();
    vi.mocked(recordAuditEvent).mockClear();
    vi.mocked(cancelRunsInTransaction).mockRejectedValueOnce(new Error("cancel failed"));
    await expect(pauseBot(prisma, { notify }, actor("owner"), "bot-1")).rejects.toThrow(
      "cancel failed",
    );
    expect(bot.pausedAt).not.toBeNull();
    expect(tx.run.findMany).toHaveBeenCalled();
    const cancelled = await pauseBot(prisma, { notify }, actor("owner"), "bot-1");
    expect(cancelled.map((run) => run.id)).toEqual(["run-1"]);
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe("a paused bot", () => {
  it("refuses a run start until it is resumed", async () => {
    const { prisma, notify } = fakeDb();
    await pauseBot(prisma, { notify }, actor("owner"), "bot-1");
    await expect(send(prisma)).rejects.toBeInstanceOf(BotPausedError);

    await resumeBot(prisma, actor("owner"), "bot-1");
    expect(recordAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "bot.resumed" }),
    );
    // Past the pause check the fake has nothing more to run, but the refusal is gone.
    await expect(send(prisma)).rejects.not.toBeInstanceOf(BotPausedError);
  });

  it("refuses a non-owner resuming it", async () => {
    const { bot, prisma, notify } = fakeDb({ peer: "member" });
    await pauseBot(prisma, { notify }, actor("owner"), "bot-1");
    await expect(resumeBot(prisma, actor("peer"), "bot-1")).rejects.toBeInstanceOf(
      SpaceOwnerRequiredError,
    );
    expect(bot.pausedAt).not.toBeNull();
  });
});
