import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { chooseModelCredential, defaultModelCredentialCandidates } from "./model-credentials.js";
import { setSpaceSettingOverride } from "./space-settings.js";

it("computer-only preferences never change main account selection", () => {
  const old = { id: "old", provider: "openai", createdAt: new Date(1), updatedAt: new Date(1) };
  const current = { ...old, id: "current", updatedAt: new Date(2) };
  const input = {
    provider: "openai",
    modelId: "gpt-4o",
    credentials: [old, current],
    preferences: [
      {
        credential: old,
        modelId: null,
        thinkingLevel: null,
        updatedAt: new Date(3),
        hasMainPreference: false,
      },
    ],
  };
  expect(chooseModelCredential(input)).toMatchObject({ source: "credential", credential: current });
  expect(defaultModelCredentialCandidates(input)[0]).toEqual(current);
});
it("copies connection computer defaults into a Space and clears them on reset, without changing account pins", async () => {
  let override = false;
  const scope = { userId: "user", spaceId: "space" };
  const preference = {
    userId: "user",
    credentialId: "connection",
    modelId: "main-model",
    thinkingLevel: "high",
    computerProvider: "anthropic",
    computerCredentialId: "other-connection",
    computerModelId: "vision-model",
    computerThinkingLevel: "low",
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
    spaceSettingOverride: {
      findUnique: vi.fn(async () => (override ? { setting: "models" } : null)),
      findMany: vi.fn(async () => (override ? [{ setting: "models" }] : [])),
      create: vi.fn(async () => {
        override = true;
      }),
      delete: vi.fn(async () => {
        override = false;
      }),
    },
    userModelPreference: { findMany: vi.fn(async () => [preference]) },
    spaceModelPreference: { createMany: vi.fn(), deleteMany: vi.fn() },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    spaceModelRoleChoice: { createMany: vi.fn(), deleteMany: vi.fn() },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  expect(await setSpaceSettingOverride(prisma, scope, "models", true)).toEqual(["models"]);
  expect(tx.spaceModelPreference.createMany).toHaveBeenCalledWith({
    data: [
      {
        ...scope,
        credentialId: "connection",
        computerProvider: "anthropic",
        computerCredentialId: "other-connection",
        computerModelId: "vision-model",
        computerThinkingLevel: "low",
      },
    ],
  });
  expect(await setSpaceSettingOverride(prisma, scope, "models", false)).toEqual([]);
  expect(tx.spaceModelPreference.deleteMany).toHaveBeenLastCalledWith({ where: scope });
  expect(preference.modelId).toBe("main-model");
});
