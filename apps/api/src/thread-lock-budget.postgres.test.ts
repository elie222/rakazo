import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  claimSteering,
  createDb,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Longer than Prisma's default five-second interactive transaction, so a write
// that waits out this hold only survives on the explicit thread-lock budget.
const THREAD_LOCK_HOLD_MS = 6_000;

describe.skipIf(!enabled)("thread writes behind a long read (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `thread-lock-budget-${randomUUID()}`;
  const notify = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ userId, spaceId, botId, threadId } = identity);
    actor = { spaceId, userId } as Actor;
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  /** A thread snapshot holds the thread row FOR SHARE; the write path waits it out. */
  function holdThreadShare() {
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const reader = system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR SHARE`;
        locked();
        await new Promise((resolve) => setTimeout(resolve, THREAD_LOCK_HOLD_MS));
      },
      { timeout: THREAD_LOCK_HOLD_MS * 3 },
    );
    return { lockTaken, reader };
  }

  it(
    "sends a message that waited behind a long thread read",
    async () => {
      const target = { kind: "bot", botId, threadId, bot: { computer: null } } as ThreadTarget;
      const clientNonce = randomUUID();
      const { lockTaken, reader } = holdThreadShare();
      await lockTaken;

      const sent = await runAsTenant({ spaceId, userId }, () =>
        sendThreadMessage(
          { prisma, sandbox: {} as never, events: { notify } as never, jobs: { enqueue } as never },
          actor,
          target,
          { text: "sent while a snapshot held the thread", mentions: [], clientNonce },
        ),
      );

      await reader;
      expect(
        await system.message.findFirstOrThrow({ where: { threadId, clientNonce } }),
      ).toMatchObject({ role: "user" });
      expect(
        await system.run.findUniqueOrThrow({
          where: { id: sent.runId },
          select: { status: true, sourceMessage: { select: { clientNonce: true } } },
        }),
      ).toMatchObject({ status: "queued", sourceMessage: { clientNonce } });
      // Keep the active-run set empty so the steering claim below sees only its own run.
      await system.run.update({ where: { id: sent.runId }, data: { status: "cancelled" } });
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "claims steering that waited behind a long thread read",
    async () => {
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "keep working", status: "running" },
      });
      const run = await system.run.create({
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
      const steering = await createThreadMessage(system, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: `mid-run request ${randomUUID()}` }],
      });
      const steeringRow = await system.steeringMessage.create({
        data: { messageId: steering.id, botId, userId },
      });

      const { lockTaken, reader } = holdThreadShare();
      await lockTaken;

      const claimed = await runAsTenant({ spaceId, userId }, () =>
        claimSteering(prisma, {
          threadId,
          botId,
          runId: run.id,
          leaseOwner: "worker-1",
          leaseFence: 1,
          seenIds: [],
        }),
      );

      await reader;
      expect(claimed.map((item) => item.messageId)).toEqual([steering.id]);
      expect(
        await system.steeringMessage.findUniqueOrThrow({ where: { id: steeringRow.id } }),
      ).toMatchObject({ runId: run.id, claimedAt: expect.any(Date) });
      await system.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    },
    THREAD_LOCK_HOLD_MS * 4,
  );
});
