import type { PrismaClient } from "@rakazo/db";
import { chooseModelCredential } from "@rakazo/db";
import { expect, it } from "vitest";
import { modelCredentialAuthKindsForSpace } from "./model-selection.js";

it.each([false, true])(
  "catalog agrees with runtime for preference hasMainPreference=%s",
  async (hasMainPreference) => {
    const old = {
      id: "old-api",
      provider: "openai-codex",
      secretId: "old-secret",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    };
    const current = {
      ...old,
      id: "current-oauth",
      secretId: "current-secret",
      createdAt: new Date(2),
      updatedAt: new Date(2),
    };
    const preference = {
      modelId: null,
      thinkingLevel: null,
      updatedAt: new Date(3),
      credential: old,
      hasMainPreference,
    };
    const prisma = {
      userModelCredential: { findMany: async () => [old, current] },
      userModelPreference: {
        findMany: async ({ select }: { select: Record<string, unknown> }) => [
          Object.fromEntries(Object.entries(preference).filter(([key]) => key in select)),
        ],
      },
      secret: {
        findMany: async () => [
          { id: "old-secret", ciphertext: "old-secret" },
          { id: "current-secret", ciphertext: "current-secret" },
        ],
      },
    } as unknown as PrismaClient;
    const store = {
      load: async (ciphertext: string) =>
        ciphertext === "old-secret"
          ? "synthetic-api-key"
          : JSON.stringify({
              type: "oauth",
              access: "synthetic-access",
              refresh: "synthetic-refresh",
              expires: Date.now() + 60000,
            }),
    };
    const auth = await modelCredentialAuthKindsForSpace(prisma, store, {
      userId: "fixture",
      spaceId: "fixture-space",
    });
    const runtime = chooseModelCredential({
      provider: "openai-codex",
      modelId: "gpt-6-astra",
      credentials: [old, current],
      preferences: [preference],
    });
    expect(auth.secretIdByProvider["openai-codex"]).toBe(
      hasMainPreference ? "old-secret" : "current-secret",
    );
    expect(auth.byProvider["openai-codex"]).toBe(hasMainPreference ? "api_key" : "oauth");
    expect(
      runtime?.source === "preference"
        ? runtime.preference.credential.secretId
        : runtime?.credential.secretId,
    ).toBe(auth.secretIdByProvider["openai-codex"]);
  },
);
