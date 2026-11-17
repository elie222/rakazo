import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  teamChatRunClientNonce,
  teamChatRunFromOwner,
} from "@rakazo/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SlackInstallProvider } from "../providers/messaging/slack/slack-install-provider.js";
import { createBackgroundJobHandlers } from "../runs/wakeups/background-job-handlers.js";
import { GraphileJobPublisher } from "../runs/wakeups/wakeup.js";
import type { SecretCleanup } from "../secrets/secret-cleanup.js";
import { secretCleanupJobKey } from "../secrets/secret-cleanup.js";
import { fakeCleanupJobs } from "../secrets/secret-cleanup.test-support.js";
import { EncryptedSecretStore } from "../secrets/secrets.js";
import { MessagingInstallations } from "./messaging-installations.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
describePostgres("messaging workspace installation (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let manager: MessagingInstallations;
  const actors: Actor[] = [];
  const bots: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      ok: true,
      access_token: "fake-install-token",
      team: { id: "T-TEST", name: "Example workspace" },
      authed_user: { id: "U-INSTALLER" },
    }),
  );
  const encrypted = new EncryptedSecretStore("fake-test-encryption-key");
  const installProvider = new SlackInstallProvider(
    {
      clientId: "fake-client",
      clientSecret: "fake-client-secret",
      signingSecret: "fake-signing-secret",
      redirectUri: "https://app.example.test/callback",
    },
    fetcher,
  );
  const start = (index: number) =>
    runAsTenant(
      actors[index]!,
      async () =>
        new URL(await manager.start(actors[index]!, bots[index]!)).searchParams.get("state")!,
    );

  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    for (let i = 0; i < 2; i++) {
      const ids = await runAsSystem("messaging install fixtures", () =>
        provisionMessagingIdentity(prisma, {
          provider: "install-test",
          address: `fake-sender-${i}`,
        }),
      );
      actors.push({
        spaceId: ids.spaceId,
        userId: ids.userId,
        email: "fake@example.test",
        isDeploymentOwner: false,
      });
      bots.push(ids.botId);
    }
    manager = new MessagingInstallations(
      prisma,
      encrypted,
      installProvider,
      fakeCleanupJobs().jobs,
    );
  });
  afterAll(async () => {
    if (prisma)
      for (const actor of actors) {
        await asSystem(prisma).organization.deleteMany({ where: { id: actor.spaceId } });
        await asSystem(prisma).user.deleteMany({ where: { id: actor.userId } });
      }
    await close?.();
  });

  it("claims OAuth state once, encrypts credentials and enforces tenant policies on both tables", async () => {
    const state = await start(0);
    expect(await runAsTenant(actors[1]!, () => prisma.messagingInstallSession.count())).toBe(0);
    expect(await runAsTenant(actors[0]!, () => prisma.messagingInstallSession.count())).toBe(1);
    const results = await Promise.allSettled([
      manager.complete(actors[0]!, state, "code"),
      manager.complete(actors[0]!, state, "code"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const own = await runAsTenant(actors[0]!, () => prisma.messagingInstallation.findMany());
    expect(own).toHaveLength(1);
    expect(own[0]!.ciphertext).not.toContain("fake-install-token");
    expect(await runAsTenant(actors[1]!, () => prisma.messagingInstallation.findMany())).toEqual(
      [],
    );
    expect((await manager.get("slack", "T-TEST"))?.credential).toBe("fake-install-token");
  });

  it("treats only the installer's own messages as the owner's", async () => {
    const installation = await asSystem(prisma).messagingInstallation.findUniqueOrThrow({
      where: { provider_workspaceId: { provider: "slack", workspaceId: "T-TEST" } },
    });
    expect(installation.ownerAddress).toBe("T-TEST:U-INSTALLER");
    const conversation = await asSystem(prisma).externalConversation.create({
      data: {
        provider: "slack",
        workspaceId: "T-TEST",
        externalKey: `${installation.id}:C-GENERAL`,
        conversationId: `slack~${installation.id}:C-GENERAL`,
        spaceId: actors[0]!.spaceId,
        botId: bots[0]!,
        userId: actors[0]!.userId,
      },
    });
    const message = (eventId: string, senderId: string, extra: object = {}) =>
      asSystem(prisma).externalMessage.create({
        data: {
          externalConversationId: conversation.id,
          providerEventId: eventId,
          senderId,
          senderName: "Fake sender",
          content: "What do you remember?",
          ...extra,
        },
      });
    const fromOwner = (eventId: string) =>
      runAsSystem("check team chat sender", () =>
        teamChatRunFromOwner(prisma, {
          externalConversationId: conversation.id,
          sourceClientNonce: teamChatRunClientNonce("slack", eventId),
        }),
      );
    const owner = await message("E-OWNER", "T-TEST:U-INSTALLER");
    const coworker = await message("E-COWORKER", "T-TEST:U-COWORKER");
    await message("E-APP", "T-TEST:U-INSTALLER", { senderIsBot: true });
    await message("E-MIXED", "T-TEST:U-INSTALLER", {
      batchContext: JSON.stringify({ prompt: "update", messageIds: [owner.id, coworker.id] }),
    });
    expect(await fromOwner("E-OWNER")).toBe(true);
    expect(await fromOwner("E-COWORKER")).toBe(false);
    expect(await fromOwner("E-APP")).toBe(false);
    expect(await fromOwner("E-MIXED")).toBe(false);
    expect(await fromOwner("E-MISSING")).toBe(false);
  });

  it("forgets the previous installer when a reconnect names nobody", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({
        ok: true,
        access_token: "fake-install-token-2",
        team: { id: "T-TEST", name: "Example workspace" },
      }),
    );
    const state = await start(0);
    await manager.complete(actors[0]!, state, "code");
    const installation = await asSystem(prisma).messagingInstallation.findUniqueOrThrow({
      where: { provider_workspaceId: { provider: "slack", workspaceId: "T-TEST" } },
    });
    expect(installation.ownerAddress).toBeNull();
  });

  it("exposes personal link availability only to current space members without exposing installation ownership", async () => {
    const memberActor = { ...actors[1]!, spaceId: actors[0]!.spaceId };
    expect(await runAsTenant(actors[1]!, () => manager.canLinkPersonalMessages(actors[1]!))).toBe(
      false,
    );
    expect(await manager.canLinkPersonalMessages(memberActor)).toBe(false);
    const space = await asSystem(prisma).space.findUniqueOrThrow({
      where: { id: memberActor.spaceId },
    });
    const memberId = randomUUID();
    let membershipId: string = randomUUID();
    await asSystem(prisma).member.create({
      data: {
        id: memberId,
        organizationId: space.organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    try {
      const membership = await asSystem(prisma).spaceMember.upsert({
        where: { spaceId_userId: { spaceId: space.id, userId: memberActor.userId } },
        update: {},
        create: {
          id: membershipId,
          organizationId: space.organizationId,
          spaceId: space.id,
          userId: memberActor.userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      membershipId = membership.id;
      expect(
        await runAsTenant(memberActor, () => manager.canLinkPersonalMessages(memberActor)),
      ).toBe(true);
      expect(await runAsTenant(memberActor, () => manager.list(memberActor))).toEqual([]);
      const ownerMembership = await asSystem(prisma).spaceMember.findUniqueOrThrow({
        where: { spaceId_userId: { spaceId: space.id, userId: actors[0]!.userId } },
      });
      await asSystem(prisma).spaceMember.delete({ where: { id: ownerMembership.id } });
      try {
        expect(
          await runAsTenant(memberActor, () => manager.canLinkPersonalMessages(memberActor)),
        ).toBe(false);
      } finally {
        await asSystem(prisma).spaceMember.create({ data: ownerMembership });
      }
      expect(
        await runAsTenant(memberActor, () => manager.canLinkPersonalMessages(memberActor)),
      ).toBe(true);
      await asSystem(prisma).spaceMember.delete({ where: { id: membershipId } });
      expect(await manager.canLinkPersonalMessages(memberActor)).toBe(false);
    } finally {
      await asSystem(prisma).spaceMember.deleteMany({ where: { id: membershipId } });
      await asSystem(prisma).member.delete({ where: { id: memberId } });
    }
  });

  it("cannot move another tenant's workspace or disconnect its installation", async () => {
    const state = await start(1);
    await expect(manager.complete(actors[1]!, state, "code")).rejects.toThrow("already connected");
    const row = (await runAsTenant(actors[0]!, () => manager.list(actors[0]!)))[0]!;
    await runAsTenant(actors[1]!, () => manager.remove(actors[1]!, row.id));
    expect((await manager.get("slack", "T-TEST"))?.spaceId).toBe(actors[0]!.spaceId);
    const personal = await asSystem(prisma).bot.create({
      data: {
        spaceId: actors[0]!.spaceId,
        userId: actors[0]!.userId,
        name: "Personal",
        color: "ink",
      },
    });
    await asSystem(prisma).messagingIdentity.create({
      data: {
        provider: "slack",
        address: "T-TEST:U1",
        dmThreadId: `slack~${row.id}:D1`,
        installationId: row.id,
        spaceId: actors[0]!.spaceId,
        userId: actors[0]!.userId,
        botId: personal.id,
      },
    });
    await runAsTenant(actors[0]!, () => manager.remove(actors[0]!, row.id));
    expect(await asSystem(prisma).messagingIdentity.count({ where: { botId: personal.id } })).toBe(
      0,
    );
    expect(await manager.get("slack", "T-TEST")).toBeNull();
  });

  it("allows only one tenant to win a concurrent workspace installation", async () => {
    const states = await Promise.all([start(0), start(1)]);
    const results = await Promise.allSettled(
      states.map((state, index) => manager.complete(actors[index]!, state, "code")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await asSystem(prisma).messagingInstallation.count({
        where: { provider: "slack", workspaceId: "T-TEST" },
      }),
    ).toBe(1);
  });
  it("stops credentials and reconciliation availability when the owner loses membership", async () => {
    const installation = await manager.get("slack", "T-TEST");
    expect(installation).not.toBeNull();
    expect(await manager.isActive(installation!.id)).toBe(true);
    await asSystem(prisma).spaceMember.deleteMany({
      where: { spaceId: installation!.spaceId, userId: installation!.userId },
    });
    expect(await manager.isActive(installation!.id)).toBe(false);
    expect(await manager.getById(installation!.id)).toBeNull();
  });
  it("deleting a shared channel bot removes its installation and linked personal DMs", async () => {
    const actor = actors[0]!;
    const shared = await asSystem(prisma).bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Shared", color: "ink" },
    });
    const personal = await asSystem(prisma).bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Personal", color: "ink" },
    });
    const installation = await asSystem(prisma).messagingInstallation.create({
      data: {
        provider: "slack",
        workspaceId: "T-CASCADE",
        workspaceName: "Example workspace",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: shared.id,
        ciphertext: "fake-unused-ciphertext",
      },
    });
    await asSystem(prisma).messagingIdentity.create({
      data: {
        provider: "slack",
        address: "T-CASCADE:U1",
        dmThreadId: `slack~${installation.id}:D1`,
        installationId: installation.id,
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: personal.id,
      },
    });
    await asSystem(prisma).bot.delete({ where: { id: shared.id } });
    expect(
      await asSystem(prisma).messagingInstallation.count({ where: { id: installation.id } }),
    ).toBe(0);
    expect(await asSystem(prisma).messagingIdentity.count({ where: { botId: personal.id } })).toBe(
      0,
    );
    expect(await asSystem(prisma).bot.count({ where: { id: personal.id } })).toBe(1);
  });
  it("commits a disconnected credential's cleanup with the removal and deletes it from the job", async () => {
    const actor = actors[0]!;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const queue = new GraphileJobPublisher(pool);
    const remove = vi.fn(async (_ref: string, _context: unknown) => undefined);
    // A store that keeps credentials elsewhere, so each one must be deleted there.
    const remote = { delete: remove, isRemote: () => true } as unknown as SecretStore;
    const ref = `remote:messaging-cleanup-${randomUUID()}`;
    const key = secretCleanupJobKey(ref);
    const removing = new MessagingInstallations(prisma, remote, installProvider, {
      enqueueIn: (tx, job) => queue.enqueueIn(tx, job),
      // The direct attempt cannot hand over, as when the process stops right after the commit.
      enqueue: async () => undefined,
      cancel: (jobKey) => queue.cancel(jobKey),
      cancelIn: (tx, jobKey) => queue.cancelIn(tx, jobKey),
    });
    try {
      const installation = await asSystem(prisma).messagingInstallation.create({
        data: {
          provider: "slack",
          workspaceId: "T-CLEANUP",
          workspaceName: "Example workspace",
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bots[0]!,
          ciphertext: ref,
        },
      });
      const cleanup: SecretCleanup = {
        kind: "messaging_installation",
        recordId: installation.id,
        ref,
      };
      const queued = async () =>
        (
          await pool.query<{ due: boolean }>(
            "select run_at <= now() as due from graphile_worker._private_jobs where key = $1",
            [key],
          )
        ).rows;
      const handlers = createBackgroundJobHandlers({
        prisma,
        secretStore: remote,
      } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
      const runJob = () =>
        runAsSystem("background job secret.cleanup", () => handlers["secret.cleanup"](cleanup));

      // While the installation holds the credential, a late retry leaves it alone.
      await runJob();
      expect(remove).not.toHaveBeenCalled();

      remove.mockRejectedValueOnce(new Error("secret store unavailable"));
      await removing.remove(actor, installation.id);
      expect(
        await asSystem(prisma).messagingInstallation.count({ where: { id: installation.id } }),
      ).toBe(0);
      expect(await queued()).toEqual([{ due: false }]);
      await runJob();
      expect(remove).toHaveBeenLastCalledWith(
        ref,
        expect.objectContaining({ recordId: installation.id }),
      );
    } finally {
      await queue.cancel(key);
      await queue.close();
      await pool.end();
    }
  });
});
