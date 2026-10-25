import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { getModelRole, updateModelRole } from "./model-roles.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20261024150000_model_roles/migration.sql",
  ),
  "utf8",
);
/** The migration's copy of each member's main model, without the table it creates. */
const backfill = migration
  .slice(migration.indexOf("INSERT INTO"))
  .split(/;\s*\n/)
  .map((statement) => statement.trim())
  .filter(Boolean);

/** Carries what a rolled-back transaction saw out of it. */
class Rollback extends Error {
  constructor(
    readonly rows: Array<{
      spaceId: string;
      role: string;
      position: number;
      provider: string;
      modelId: string;
    }>,
    readonly main: unknown,
  ) {
    super("rollback");
  }
}

describePostgres("model roles (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `model-roles-user-${suffix}`;
  const organizationId = `model-roles-organization-${suffix}`;
  const spaceId = `model-roles-space-${suffix}`;
  const otherSpaceId = `model-roles-other-space-${suffix}`;
  const anthropic = `model-roles-anthropic-${suffix}`;
  const compatible = `model-roles-compatible-${suffix}`;
  const scope = { userId, spaceId };
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  const mainRows = (space = spaceId) =>
    prisma.spaceModelRoleChoice.findMany({
      where: { userId, spaceId: space, role: "main" },
      orderBy: { position: "asc" },
      select: { position: true, provider: true, modelId: true, thinkingLevel: true },
    });
  const legacy = async () => ({
    defaults: await prisma.spaceModelPreference.findMany({
      where: { userId, spaceId, isDefault: true },
      select: { credentialId: true, modelId: true, thinkingLevel: true },
    }),
    backups: await prisma.spaceBackupModel.findMany({
      where: { userId, spaceId },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true },
    }),
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const createdAt = new Date();
    await prisma.user.create({
      data: {
        id: userId,
        name: "Model Roles",
        email: `${userId}@rakazo.test`,
        emailVerified: false,
      },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Model Roles", slug: organizationId, createdAt },
    });
    await prisma.member.create({
      data: { id: `${userId}-member`, organizationId, userId, role: "owner", createdAt },
    });
    for (const id of [spaceId, otherSpaceId]) {
      await prisma.space.create({
        data: { id, organizationId, name: id, createdByUserId: userId },
      });
      await prisma.spaceMember.create({
        data: { id: `${id}-member`, spaceId: id, organizationId, userId, createdAt },
      });
    }
    for (const [id, provider] of [
      [anthropic, "azure-openai-responses"],
      [compatible, "openai-compatible"],
    ] as const) {
      await prisma.secret.create({
        data: { id, userId, kind: "model", ciphertext: "fake-ciphertext" },
      });
      await prisma.userModelCredential.create({
        data: { id, userId, provider, label: provider, secretId: id },
      });
    }
  });

  beforeEach(async () => {
    await prisma.spaceModelRoleChoice.deleteMany({ where: { userId } });
    await prisma.spaceModelPreference.deleteMany({ where: { userId } });
    await prisma.spaceBackupModel.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("backfills the main model from the default preference and the backup list", async () => {
    await prisma.spaceModelPreference.createMany({
      data: [
        {
          spaceId,
          userId,
          credentialId: anthropic,
          modelId: " gpt-5 ",
          thinkingLevel: "high",
          isDefault: true,
        },
        { spaceId, userId, credentialId: compatible, modelId: "llama", isDefault: false },
        // Nothing to copy: the previous release ran the provider's catalog default here.
        {
          spaceId: otherSpaceId,
          userId,
          credentialId: anthropic,
          modelId: "null",
          isDefault: true,
        },
      ],
    });
    await prisma.spaceBackupModel.createMany({
      data: [
        { spaceId, userId, position: 0, provider: "openai-compatible", modelId: "llama" },
        { spaceId, userId, position: 1, provider: "azure", modelId: "gpt-5" },
        { spaceId, userId, position: 2, provider: "xai", modelId: "grok" },
        { spaceId: otherSpaceId, userId, position: 0, provider: "xai", modelId: "grok" },
      ],
    });

    const copied = await prisma
      .$transaction(async (tx) => {
        for (const statement of backfill) await tx.$executeRawUnsafe(statement);
        const rows = await tx.spaceModelRoleChoice.findMany({
          where: { userId },
          orderBy: [{ spaceId: "asc" }, { position: "asc" }],
          select: { spaceId: true, role: true, position: true, provider: true, modelId: true },
        });
        const main = await getModelRole(tx, scope, "main");
        throw new Rollback(rows, main);
      })
      .catch((error: unknown) => {
        if (error instanceof Rollback) return error;
        throw error;
      });

    expect(copied.main).toEqual({
      primary: { provider: "azure", modelId: "gpt-5", thinkingLevel: "high" },
      backups: [
        { provider: "openai-compatible", modelId: "llama" },
        { provider: "xai", modelId: "grok" },
      ],
    });
    // The other Space's default had no usable model, so only its fallback moves, still first.
    expect(copied.rows).toContainEqual({
      spaceId: otherSpaceId,
      role: "main",
      position: 1,
      provider: "xai",
      modelId: "grok",
    });
    expect(copied.rows.filter((row) => row.spaceId === otherSpaceId)).toHaveLength(1);
    // The backfill ran in a rolled-back transaction.
    expect(await mainRows()).toEqual([]);
  });

  it("writes the main model where both releases read it", async () => {
    await updateModelRole(
      prisma,
      scope,
      "main",
      {
        primary: { provider: "openai-compatible", modelId: "llama", thinkingLevel: "low" },
        backups: [{ provider: "azure-openai-responses", modelId: "gpt-5" }],
      },
      { primaryCredentialId: compatible },
    );

    expect(await mainRows()).toEqual([
      { position: 0, provider: "openai-compatible", modelId: "llama", thinkingLevel: "low" },
      { position: 1, provider: "azure", modelId: "gpt-5", thinkingLevel: null },
    ]);
    expect(await legacy()).toEqual({
      defaults: [{ credentialId: compatible, modelId: "llama", thinkingLevel: "low" }],
      backups: [{ provider: "azure", modelId: "gpt-5" }],
    });

    // A deployment-managed main model has no connection for the previous release to default to.
    await updateModelRole(
      prisma,
      scope,
      "main",
      { primary: { provider: "openrouter", modelId: "managed" } },
      { primaryCredentialId: null },
    );
    expect(await legacy()).toEqual({
      defaults: [],
      backups: [{ provider: "azure", modelId: "gpt-5" }],
    });
  });

  it("keeps a model's effort when the list is reordered", async () => {
    await updateModelRole(
      prisma,
      scope,
      "main",
      {
        primary: { provider: "azure", modelId: "gpt-5", thinkingLevel: "high" },
        backups: [{ provider: "openai-compatible", modelId: "llama" }],
      },
      { primaryCredentialId: anthropic },
    );
    await updateModelRole(
      prisma,
      scope,
      "main",
      {
        primary: { provider: "openai-compatible", modelId: "llama" },
        backups: [{ provider: "azure", modelId: "gpt-5" }],
      },
      { primaryCredentialId: compatible },
    );

    await expect(getModelRole(prisma, scope, "main")).resolves.toEqual({
      primary: { provider: "openai-compatible", modelId: "llama" },
      backups: [{ provider: "azure", modelId: "gpt-5", thinkingLevel: "high" }],
    });
    expect((await legacy()).defaults).toEqual([
      { credentialId: compatible, modelId: "llama", thinkingLevel: null },
    ]);
  });

  it("leaves the previous release's main model alone when only fallbacks change", async () => {
    await updateModelRole(
      prisma,
      scope,
      "main",
      { primary: { provider: "azure", modelId: "gpt-5" } },
      { primaryCredentialId: anthropic },
    );
    await updateModelRole(prisma, scope, "main", {
      backups: [{ provider: "xai", modelId: "grok" }],
    });

    expect(await legacy()).toEqual({
      defaults: [{ credentialId: anthropic, modelId: "gpt-5", thinkingLevel: null }],
      backups: [{ provider: "xai", modelId: "grok" }],
    });
    // Other purposes never touch the main model's tables.
    await updateModelRole(prisma, scope, "approval", {
      primary: { provider: "xai", modelId: "grok-mini" },
    });
    expect((await legacy()).backups).toEqual([{ provider: "xai", modelId: "grok" }]);
  });
});
