import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  sendUserMessage as sendUserMessageTo,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TeamChatBridge } from "./team-chat-bridge.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("TeamChat deferred routing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const address = `teamchat-${randomUUID()}@example.test`;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
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
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("keeps a message dropped for a Space being deleted out of the agent after lease recovery", async () => {
    const { spaceId, userId, botId } = identity;
    const sendUserMessage = vi.fn((input: Parameters<typeof sendUserMessageTo>[1]) =>
      sendUserMessageTo(system, input),
    );
    // The Space is being deleted: the transcript copy is kept, a run is refused.
    await system.space.update({
      where: { id: spaceId },
      data: { deletingAt: new Date(), deletionClaimId: `organization-deletion:${spaceId}:x` },
    });
    const bridge = new TeamChatBridge({
      prisma: system,
      events: { sendUserMessage } as never,
      jobs: { enqueue: vi.fn(async () => undefined) } as never,
      send: vi.fn(),
      providerId: "slack",
      botId,
    });
    const target = { id: botId, spaceId, userId, name: "Chief" };
    (bridge as unknown as { target: typeof target }).target = target;

    try {
      const routed = await runAsSystem("teamchat routing", () =>
        bridge.receive(
          {
            eventId: `Ev-${randomUUID()}`,
            workspaceId: "T-1",
            kind: "mention",
            conversationKey: "channel:C-1:100.1",
            conversationId: "C-1",
            replyThreadId: null,
            senderId: "U-1",
            senderName: "Ada",
            content: "Run the release routine",
          },
          { queueAgent: false },
        ),
      );
      if (!("externalMessageId" in routed)) throw new Error("expected a deferred message");
      const id = routed.externalMessageId;
      // The reservation lapses, and recovery hands the message back to agent routing.
      await system.externalMessage.update({
        where: { id },
        data: { nextAttemptAt: new Date(Date.now() - 60_000) },
      });
      await runAsSystem("teamchat recovery", () =>
        (
          bridge as unknown as {
            recoverExpiredDeferredMessages(t: typeof target, now: Date): Promise<void>;
          }
        ).recoverExpiredDeferredMessages(target, new Date()),
      );
      const recovered = (await system.externalMessage.findUniqueOrThrow({ where: { id } })).status;

      // The routine's wake is then refused for the Space being deleted.
      const dropped = await bridge.resolveDeferredMessage(id, "ignored", "mention");
      sendUserMessage.mockClear();
      await runAsSystem("teamchat reconcile", () => bridge.reconcileOnce());

      expect({
        recovered,
        dropped,
        status: (await system.externalMessage.findUniqueOrThrow({ where: { id } })).status,
        fallbackRuns: sendUserMessage.mock.calls.filter(([input]) => input.createRun !== false)
          .length,
      }).toEqual({ recovered: "received", dropped: true, status: "ignored", fallbackRuns: 0 });
    } finally {
      await system.space.update({
        where: { id: spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
    }
  });
});
