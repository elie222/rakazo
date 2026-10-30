import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MessagingInstallations } from "./messaging-installations.js";
import { EncryptedSecretStore } from "./secrets.js";
import { SlackInstallProvider } from "./slack-install-provider.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
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
    }),
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
        provisionMessagingIdentity(
          prisma,
          { provider: "install-test", address: `fake-sender-${i}` },
          { signupsEnabled: "true", signupAllowlist: undefined },
        ),
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
      new EncryptedSecretStore("fake-test-encryption-key"),
      new SlackInstallProvider(
        {
          clientId: "fake-client",
          clientSecret: "fake-client-secret",
          signingSecret: "fake-signing-secret",
          redirectUri: "https://app.example.test/callback",
        },
        fetcher,
      ),
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
});
