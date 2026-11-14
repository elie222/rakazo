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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimIdempotencyKey,
  finishIdempotencyKey,
  holdIdempotencyKey,
  releaseIdempotencyKey,
} from "./service-idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("service API idempotency keys (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
  let credentialId: string;

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `service-idempotency-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    const credential = await system.serviceCredential.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        name: "test key",
        tokenHash: randomUUID(),
        tokenPrefix: "rks_test",
        scopes: ["bots:read"],
        botIds: [],
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    credentialId = credential.id;
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  it("keeps a running write's claim from lapsing", async () => {
    const claim = await system.serviceIdempotencyKey.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        credentialId,
        key: "slow",
        requestHash: "h",
        expiresAt: new Date(Date.now() + 1000),
      },
    });
    await runAsTenant(actor, () => holdIdempotencyKey(prisma, claim.id));
    const row = await system.serviceIdempotencyKey.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
  });

  it("leaves a retry's claim alone when the first request's claim lapsed", async () => {
    const claim = () =>
      runAsTenant(actor, () => claimIdempotencyKey(prisma, actor, credentialId, "lapsed", "h"));
    const first = await claim();
    if (first.kind !== "claimed") throw new Error("expected a claim");
    await system.serviceIdempotencyKey.updateMany({
      where: { id: first.claimId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const retry = await claim();
    if (retry.kind !== "claimed") throw new Error("expected the retry to claim");

    const finish = (claimId: string, from: string) =>
      runAsTenant(actor, () => finishIdempotencyKey(prisma, claimId, 200, { from }));
    expect(await finish(first.claimId, "first")).toBe(false);
    await runAsTenant(actor, () => releaseIdempotencyKey(prisma, first.claimId));
    const row = await system.serviceIdempotencyKey.findFirstOrThrow({
      where: { credentialId, key: "lapsed" },
    });
    expect([row.id, row.responseStatus]).toEqual([retry.claimId, null]);
    expect(await finish(retry.claimId, "retry")).toBe(true);
  });
});
