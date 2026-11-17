import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { handle } from "../router-test-support.js";

const suite = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
suite("personal connection removal preserves credit models (PostgreSQL)", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `credit-disconnect-user-${stamp}`;
  const organizationId = `credit-disconnect-org-${stamp}`;
  const spaceIds = [`credit-disconnect-a-${stamp}`, `credit-disconnect-b-${stamp}`];
  const credentialId = `credit-disconnect-key-${stamp}`;
  const secretId = `credit-disconnect-secret-${stamp}`;
  const actor: Actor = {
    userId,
    spaceId: spaceIds[0]!,
    email: `credit-disconnect-${stamp}@rakazo.test`,
    isDeploymentOwner: false,
  };
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    const createdAt = new Date();
    await system.user.create({
      data: { id: userId, name: "Disconnect fixture", email: actor.email, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Disconnect fixture", slug: organizationId, createdAt },
    });
    await system.member.create({
      data: {
        id: `credit-disconnect-member-${stamp}`,
        organizationId,
        userId,
        role: "owner",
        createdAt,
      },
    });
    for (const spaceId of spaceIds) {
      await system.space.create({
        data: { id: spaceId, organizationId, name: "Fixture", createdByUserId: userId },
      });
      await system.spaceMember.create({
        data: { id: `${spaceId}-member`, spaceId, organizationId, userId, createdAt },
      });
    }
  });
  beforeEach(async () => {
    await system.userModelRoleChoice.deleteMany({ where: { userId } });
    await system.spaceModelRoleChoice.deleteMany({ where: { userId } });
    await system.userModelCredential.deleteMany({ where: { userId } });
    await system.secret.deleteMany({ where: { userId } });
    await system.secret.create({
      data: { id: secretId, userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await system.userModelCredential.create({
      data: { id: credentialId, userId, provider: "openai", label: "Personal", secretId },
    });
    const choices = [
      {
        userId,
        role: "main",
        position: 0,
        provider: "openai",
        modelId: "example-model",
        creditOfferingId: "approved-fixture",
      },
      {
        userId,
        role: "main",
        position: 1,
        provider: "openai",
        modelId: "example-model",
        credentialId,
      },
      { userId, role: "main", position: 2, provider: "openai", modelId: "legacy-model" },
      { userId, role: "main", position: 3, provider: "anthropic", modelId: "other-model" },
    ];
    await system.userModelRoleChoice.createMany({ data: choices });
    await system.spaceModelRoleChoice.createMany({
      data: spaceIds.flatMap((spaceId) => choices.map((choice) => ({ ...choice, spaceId }))),
    });
  });
  afterAll(async () => {
    await system.organization.delete({ where: { id: organizationId } });
    await system.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  it.each(["named", "provider-wide"])(
    "preserves account and every Space credit choice when removing the last key (%s)",
    async (kind) => {
      const deps = {
        prisma: db.prisma,
        oauthLogins: { cancelProvider: vi.fn(async () => undefined) },
        env: {
          defaultProvider: "scripted",
          defaultModel: "fake-model",
          webOrigin: "https://example.test",
          screenProxySecret: "fake-test-secret",
          sandboxProvider: "fake",
          agentRuntime: "scripted",
        },
      } as unknown as RouterDeps;
      let failure: unknown;
      const handler = new RPCHandler(createRouter(deps), {
        clientInterceptors: [
          onError((error) => {
            failure = error;
          }),
        ],
      });
      const response = await handle(
        handler,
        new Request("https://api.example.test/rpc/models/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            json: { provider: "openai", ...(kind === "named" ? { credentialId } : {}) },
          }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      expect(failure).toBeUndefined();
      expect(response.status).toBe(200);
      const remaining = [
        {
          provider: "openai",
          modelId: "example-model",
          creditOfferingId: "approved-fixture",
          credentialId: null,
          position: 0,
        },
        {
          provider: "anthropic",
          modelId: "other-model",
          creditOfferingId: null,
          credentialId: null,
          position: 3,
        },
      ];
      const select = {
        provider: true,
        modelId: true,
        creditOfferingId: true,
        credentialId: true,
        position: true,
      } as const;
      expect(
        await system.userModelRoleChoice.findMany({
          where: { userId },
          orderBy: { position: "asc" },
          select,
        }),
      ).toEqual(remaining);
      for (const spaceId of spaceIds)
        expect(
          await system.spaceModelRoleChoice.findMany({
            where: { userId, spaceId },
            orderBy: { position: "asc" },
            select,
          }),
        ).toEqual(remaining);
      expect(await system.userModelCredential.count({ where: { userId } })).toBe(0);
      expect(await system.secret.count({ where: { id: secretId } })).toBe(0);
    },
  );
});
