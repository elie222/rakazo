import { randomUUID } from "node:crypto";
import {
  EncryptedSecretStore,
  loadAdminDeploymentModelKey,
  matchingAdminDeploymentModel,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { asSystem, createDb } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import type { DeploymentModelSettingsDeps } from "./deployment-model-settings.js";
import {
  getDeploymentModelSettings,
  updateDeploymentModelSettings,
} from "./deployment-model-settings.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl)(
  "saves the admin's model for everyone where runs read its key, and removes it again",
  async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `deployment-model-${userId}@example.test`;
    const secrets = new EncryptedSecretStore("test-only-encryption-key");
    const deps = {
      prisma: db.prisma,
      secrets,
      jobs: {},
      modelConnectionCheck: vi.fn(async () => undefined),
      env: { adminEmails: [email] },
    } as unknown as DeploymentModelSettingsDeps;
    const admin: Actor = { userId, spaceId: "unused-space", email, isDeploymentOwner: false };
    const before = await system.deploymentSettings.findUnique({ where: { id: "default" } });
    try {
      const legacyModel = { defaultModelProvider: "local", defaultModelId: "existing-model" };
      await system.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", ...legacyModel },
        update: legacyModel,
      });
      await system.user.create({
        data: { id: userId, name: "Admin", email, emailVerified: true },
      });
      await updateDeploymentModelSettings(deps, admin, {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        apiKey: "fake-admin-key",
      });
      const row = await system.deploymentSettings.findUnique({ where: { id: "default" } });
      expect(row).toMatchObject({
        ...legacyModel,
        deploymentModelProvider: "anthropic",
        deploymentModelId: "claude-sonnet-5",
      });
      expect(row?.deploymentModelCredentialCipher).toBeTruthy();
      expect(row?.deploymentModelCredentialCipher).not.toContain("fake-admin-key");
      await expect(
        loadAdminDeploymentModelKey(
          secrets,
          matchingAdminDeploymentModel(row, "anthropic", "claude-sonnet-5")!.cipher,
        ),
      ).resolves.toBe("fake-admin-key");
      expect(await getDeploymentModelSettings(deps, admin)).toMatchObject({
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        keySaved: true,
      });

      await updateDeploymentModelSettings(deps, admin, { provider: null });
      const reset = await system.deploymentSettings.findUnique({ where: { id: "default" } });
      expect(reset).toMatchObject({
        ...legacyModel,
        deploymentModelProvider: null,
        deploymentModelId: null,
        deploymentModelCredentialCipher: null,
      });
      expect(matchingAdminDeploymentModel(reset, "anthropic", "claude-sonnet-5")).toBeNull();
    } finally {
      await system.deploymentSettings.update({
        where: { id: "default" },
        data: {
          defaultModelProvider: before?.defaultModelProvider ?? null,
          defaultModelId: before?.defaultModelId ?? null,
          deploymentModelProvider: before?.deploymentModelProvider ?? null,
          deploymentModelId: before?.deploymentModelId ?? null,
          deploymentModelCredentialCipher: before?.deploymentModelCredentialCipher ?? null,
        },
      });
      await system.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
