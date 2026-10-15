import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb, Prisma } from "./client.js";
import { createExecutionProfile, resolveRunExecutionProfile } from "./execution-profiles.js";
import {
  claimNativeHarnessSession,
  updateNativeHarnessSession,
} from "./native-harness-sessions.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("execution profile migration (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `profile-user-${suffix}`;
  const organizationId = `profile-org-${suffix}`;
  const spaceId = `profile-space-${suffix}`;
  const botId = `profile-bot-${suffix}`;
  const threadId = `profile-thread-${suffix}`;
  const taskId = `profile-task-${suffix}`;
  const credentialId = `profile-account-${suffix}`;
  const secretId = `profile-secret-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: "Profile Test", email: `${userId}@example.test` },
    });
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Profile Test",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    await prisma.member.create({
      data: {
        id: `member-${suffix}`,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await prisma.secret.create({
      data: { id: secretId, userId, kind: "model", ciphertext: "fake-offline-placeholder" },
    });
    await prisma.userModelCredential.create({
      data: {
        id: credentialId,
        userId,
        provider: "anthropic",
        label: "Original account",
        secretId,
      },
    });
    await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Bot", color: "ink" } });
    await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
    await prisma.task.create({
      data: {
        id: taskId,
        spaceId,
        userId,
        botId,
        threadId,
        prompt: "Offline test",
        status: "queued",
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.bot.deleteMany({ where: { id: botId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.nativeStateCleanup.deleteMany({ where: { spaceId, userId } });
    await close();
  });

  const createRun = (trigger: string) =>
    prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId,
        trigger,
        status: "queued",
      },
    });

  it("retires only the selected account when sibling credentials share a secret", async () => {
    const sharedSecretId = `shared-secret-${suffix}`;
    const rotatedSecretId = `rotated-secret-${suffix}`;
    await prisma.secret.createMany({
      data: [sharedSecretId, rotatedSecretId].map((id) => ({
        id,
        userId,
        kind: "model",
        ciphertext: "fake-shared-secret",
      })),
    });
    const accounts = await Promise.all(
      ["selected", "sibling"].map((name) =>
        prisma.userModelCredential.create({
          data: {
            id: `${name}-account-${suffix}`,
            userId,
            provider: "anthropic",
            label: name,
            secretId: sharedSecretId,
          },
        }),
      ),
    );
    const profiles = await Promise.all(
      accounts.map((account) =>
        createExecutionProfile(
          prisma,
          { spaceId, userId },
          {
            name: account.label,
            harness: "claude",
            provider: "anthropic",
            credentialId: account.id,
            protocol: "anthropic",
            authScheme: "api-key",
            modelRoles: {},
            endpoint: "https://api.example.test",
            modelId: "offline-model",
            inputModalities: [],
            runtimeVersion: "0.3.300",
            computerId: null,
          },
        ),
      ),
    );
    async function sessionFor(index: number) {
      const profile = profiles[index]!;
      await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: profile.id } });
      const run = await createRun("message");
      const scope = {
        spaceId,
        userId,
        botId,
        threadId,
        profileId: profile.id,
        runId: run.id,
        leaseFence: run.leaseFence,
      };
      const session = await claimNativeHarnessSession(prisma, scope);
      await prisma.nativeHarnessSession.update({
        where: { id: session.id },
        data: {
          cleanupScope: {
            computerId: "shared-secret-computer",
            computer: {
              id: "fake-container",
              providerRef: "fake-container",
              botId: "fake-home",
              kind: "docker",
            },
            botId,
            request: {
              expectedInstallationId: "a".repeat(32),
              sessionScope: {
                threadId,
                profileId: profile.id,
                profileRevision: profile.revision,
                accountId: accounts[index]!.id,
                epoch: session.epoch,
              },
            },
          },
        },
      });
      await updateNativeHarnessSession(prisma, { ...scope, outcome: "completed" });
      return session;
    }
    const selected = await sessionFor(0);
    const sibling = await sessionFor(1);
    await prisma.userModelCredential.update({
      where: { id: accounts[0]!.id },
      data: { secretId: rotatedSecretId },
    });
    expect(await prisma.nativeHarnessSession.findUnique({ where: { id: selected.id } })).toBeNull();
    expect(
      await prisma.nativeHarnessSession.findUnique({ where: { id: sibling.id } }),
    ).not.toBeNull();
    expect(await prisma.nativeStateCleanup.count({ where: { spaceId, userId } })).toBe(1);

    // Reconnect the selected account to the shared secret, then test the DELETE trigger too.
    await prisma.userModelCredential.update({
      where: { id: accounts[0]!.id },
      data: { secretId: sharedSecretId },
    });
    const reconnected = await sessionFor(0);
    await prisma.userModelCredential.delete({ where: { id: accounts[0]!.id } });
    expect(
      await prisma.nativeHarnessSession.findUnique({ where: { id: reconnected.id } }),
    ).toBeNull();
    expect(
      await prisma.nativeHarnessSession.findUnique({ where: { id: sibling.id } }),
    ).not.toBeNull();
    const queued = await prisma.nativeStateCleanup.findMany({ where: { spaceId, userId } });
    expect(queued).toHaveLength(2);
    for (const row of queued)
      expect(row.scope).toMatchObject({
        request: { sessionScope: { profileId: profiles[0]!.id, accountId: accounts[0]!.id } },
      });

    await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: null } });
    await prisma.userModelCredential.delete({ where: { id: accounts[1]!.id } });
    await prisma.nativeStateCleanup.deleteMany({ where: { spaceId, userId } });
  });

  it("preserves Pi defaults, pins every insertion, and rejects mutation or revoked credentials", async () => {
    const legacy = await createRun("message");
    expect(legacy.executionProfileSnapshot).toBeNull();
    const profile = await createExecutionProfile(
      prisma,
      { spaceId, userId },
      {
        name: "Original profile",
        harness: "claude",
        provider: "anthropic",
        credentialId,
        protocol: "anthropic",
        authScheme: "api-key",
        modelRoles: {},
        endpoint: "https://api.example.test",
        modelId: "offline-model",
        inputModalities: ["image"],
        runtimeVersion: "0.3.300",
        computerId: null,
      },
    );
    await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: profile.id } });
    const runs = [];
    for (const trigger of [
      "message",
      "bot_message",
      "routine",
      "messaging",
      "follow_up",
      "created",
      "call_end",
    ]) {
      const run = await createRun(trigger);
      expect(run.executionProfileSnapshot).toMatchObject({
        profileId: profile.id,
        profileName: "Original profile",
        credentialId,
        credentialSecretId: secretId,
        credentialLabel: "Original account",
        harness: "claude",
        inputModalities: ["image"],
      });
      runs.push(run);
    }
    await expect(
      prisma.executionProfile.update({ where: { id: profile.id }, data: { name: "Changed" } }),
    ).rejects.toThrow("immutable");
    await expect(
      prisma.run.update({
        where: { id: runs[0]!.id },
        data: { executionProfileSnapshot: Prisma.DbNull },
      }),
    ).rejects.toThrow("immutable");
    await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: null } });
    const saved = await prisma.run.findUniqueOrThrow({ where: { id: runs[0]!.id } });
    expect((await resolveRunExecutionProfile(prisma, saved))?.profile.id).toBe(profile.id);
    await prisma.userModelCredential.update({
      where: { id: credentialId },
      data: { label: "Renamed account" },
    });
    expect(saved.executionProfileSnapshot).toMatchObject({ credentialLabel: "Original account" });
    const nativeScope = {
      spaceId,
      userId,
      botId,
      threadId,
      profileId: profile.id,
      runId: saved.id,
      leaseFence: saved.leaseFence,
    };
    const oldSession = await claimNativeHarnessSession(prisma, nativeScope);
    const cleanupScope = {
      computerId: "fake-computer",
      computer: {
        id: "fake-container",
        providerRef: "fake-container",
        botId: "fake-home",
        kind: "docker",
      },
      botId,
      request: {
        expectedInstallationId: "a".repeat(32),
        sessionScope: {
          threadId,
          profileId: profile.id,
          profileRevision: profile.revision,
          accountId: credentialId,
          epoch: oldSession.epoch,
        },
      },
    };
    await prisma.nativeHarnessSession.update({
      where: { id: oldSession.id },
      data: { cleanupScope },
    });
    await updateNativeHarnessSession(prisma, {
      ...nativeScope,
      nativeSessionId: "offline-old-account-checkpoint",
      outcome: "completed",
    });
    const replacementSecretId = `${secretId}-replacement`;
    await prisma.secret.create({
      data: { id: replacementSecretId, userId, kind: "model", ciphertext: "fake-replacement" },
    });
    await prisma.userModelCredential.update({
      where: { id: credentialId },
      data: { secretId: replacementSecretId },
    });
    expect(
      await prisma.nativeHarnessSession.findUnique({ where: { id: oldSession.id } }),
    ).toBeNull();
    expect(await prisma.nativeStateCleanup.count({ where: { spaceId, userId } })).toBe(1);
    await expect(resolveRunExecutionProfile(prisma, saved)).rejects.toThrow("account changed");
    await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: profile.id } });
    const newAccountRun = await createRun("message");
    const newSession = await claimNativeHarnessSession(prisma, {
      ...nativeScope,
      runId: newAccountRun.id,
      leaseFence: newAccountRun.leaseFence,
    });
    expect(newSession.epoch).not.toBe(oldSession.epoch);
    const cleanup = await prisma.nativeStateCleanup.findFirstOrThrow({
      where: { spaceId, userId },
    });
    expect(cleanup.scope).toMatchObject({ request: { sessionScope: { epoch: oldSession.epoch } } });
    expect(cleanup.computerId).toBe("fake-computer");
    expect(newSession.nativeSessionId).toBeNull();
    expect(newSession.credentialSecretId).toBe(replacementSecretId);
    await updateNativeHarnessSession(prisma, {
      ...nativeScope,
      runId: newAccountRun.id,
      leaseFence: newAccountRun.leaseFence,
      outcome: "completed",
    });
    await prisma.nativeHarnessSession.update({
      where: { id: newSession.id },
      data: {
        cleanupScope: {
          ...cleanupScope,
          request: {
            ...cleanupScope.request,
            sessionScope: { ...cleanupScope.request.sessionScope, epoch: newSession.epoch },
          },
        },
      },
    });
    await prisma.userModelCredential.delete({ where: { id: credentialId } });
    expect(
      await prisma.nativeHarnessSession.findUnique({ where: { id: newSession.id } }),
    ).toBeNull();
    expect(await prisma.nativeStateCleanup.count({ where: { spaceId, userId } })).toBe(2);
    expect(await prisma.executionProfile.findUnique({ where: { id: profile.id } })).not.toBeNull();
    await expect(resolveRunExecutionProfile(prisma, saved)).rejects.toThrow("disconnected");
    await prisma.bot.update({ where: { id: botId }, data: { executionProfileId: profile.id } });
    await expect(createRun("message")).rejects.toThrow("credential disconnected");
    await prisma.bot.delete({ where: { id: botId } });
    const afterCascade = await prisma.nativeStateCleanup.findMany({ where: { spaceId, userId } });
    expect(afterCascade).toHaveLength(2);
    expect(afterCascade.some((row) => JSON.stringify(row.scope).includes(newSession.epoch))).toBe(
      true,
    );
  });
});
