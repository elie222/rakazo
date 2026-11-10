import {
  deploymentConnection,
  deploymentConnectionSecret,
  deploymentServes,
  EncryptedSecretStore,
  environmentDeploymentModels,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  connectDeploymentModel,
  currentDeploymentModels,
  disconnectDeploymentModel,
  updateDeploymentModelSettings,
} from "./deployment-model.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? it : it.skip;
const stamp = `${process.pid}-${Date.now()}`;
const email = `deployment-model-${stamp}@rakazo.test`;
const actor = { userId: `admin-${stamp}`, spaceId: `space-${stamp}`, email } as never;
let db: ReturnType<typeof createDb>;
let fixtures: PrismaClient;

beforeAll(async () => {
  if (!process.env.VERIFY_DATABASE || !process.env.DATABASE_URL) return;
  db = createDb(process.env.DATABASE_URL);
  fixtures = asSystem(db.prisma);
  await fixtures.user.create({
    data: { id: `admin-${stamp}`, name: "Admin", email, emailVerified: true },
  });
});

afterAll(async () => {
  if (!db) return;
  await fixtures.user.delete({ where: { id: `admin-${stamp}` } });
  await db.prisma.$disconnect();
  await db.pool.end();
});

dbTests("saves, applies and removes an admin's model connection without a restart", async () => {
  const secrets = new EncryptedSecretStore("fake-deployment-model-test-encryption-key");
  const deps = {
    prisma: db.prisma,
    secrets,
    // The provider accepts the key.
    modelConnectionFetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    env: {
      adminEmails: [email],
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-haiku-5.5",
      deploymentModels: environmentDeploymentModels({ OPENROUTER_API_KEY: "fixture-env-key" }),
    },
  };
  await connectDeploymentModel(deps, actor, {
    provider: "deepseek",
    apiKey: "fixture-deepseek-key",
  });
  await updateDeploymentModelSettings(deps, actor, {
    defaultModel: { provider: "deepseek", modelId: "deepseek-flash" },
    allowedModels: ["deepseek:*"],
  });
  const row = await fixtures.deploymentModelConnection.findUniqueOrThrow({
    where: { provider: "deepseek" },
  });
  expect(row.ciphertext).not.toContain("fixture-deepseek-key");

  // Another process reading the database sees the change.
  const models = await currentDeploymentModels(deps);
  expect(models.default).toMatchObject({
    provider: "deepseek",
    model: "deepseek-flash",
    configured: true,
  });
  expect(deploymentServes(models, "deepseek", "deepseek-v4-pro")).toBe(true);
  await expect(
    deploymentConnectionSecret(secrets, deploymentConnection(models, "deepseek")),
  ).resolves.toEqual({ kind: "api_key", key: "fixture-deepseek-key" });

  await disconnectDeploymentModel(deps, actor, { provider: "deepseek" });
  await updateDeploymentModelSettings(deps, actor, { allowedModels: null });
  const restored = await currentDeploymentModels(deps);
  expect(restored.default).toMatchObject({ provider: "openrouter", configured: true });
  expect(deploymentServes(restored, "deepseek", "deepseek-v4-pro")).toBe(false);
  expect(
    await fixtures.deploymentModelConnection.findUnique({ where: { provider: "deepseek" } }),
  ).toBeNull();
});

dbTests("keeps both of two provider switches made at once", async () => {
  const deps = {
    prisma: db.prisma,
    secrets: new EncryptedSecretStore("fake-deployment-model-test-encryption-key"),
    modelConnectionFetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    env: {
      adminEmails: [email],
      defaultProvider: "openrouter",
      defaultModel: "anthropic/claude-haiku-5.5",
      deploymentModels: environmentDeploymentModels({ OPENROUTER_API_KEY: "fixture-env-key" }),
    },
  };
  for (const provider of ["deepseek", "anthropic"])
    await connectDeploymentModel(deps, actor, { provider, apiKey: `fixture-${provider}-key` });
  await updateDeploymentModelSettings(deps, actor, { allowedModels: [] });
  try {
    await Promise.all(
      ["deepseek", "anthropic"].map((provider) =>
        updateDeploymentModelSettings(deps, actor, { open: { provider, open: true } }),
      ),
    );
    const models = await currentDeploymentModels(deps);
    expect([...models.allowed].sort()).toEqual(["anthropic:*", "deepseek:*"]);
  } finally {
    for (const provider of ["deepseek", "anthropic"])
      await disconnectDeploymentModel(deps, actor, { provider });
    await updateDeploymentModelSettings(deps, actor, { allowedModels: null });
  }
});
