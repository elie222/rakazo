import type { PrismaClient } from "@rakazo/db";
import { reserveModelCredits } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectedModelChoices } from "./model-choice.js";
import { modelFunding } from "./model-funding.js";
import { validateBotModelChange, validateConnectedModelChoice } from "./model-selection.js";
import { listPiCatalog } from "./pi-models.js";
import { resolveModelKey } from "./run-model.js";

const provider = "openrouter";
const scope = { userId: "fixture-user", spaceId: "fixture-space" };
const unpriced = "auto";
const priced = listPiCatalog().find(
  (entry) =>
    entry.provider === provider && modelFunding(provider, entry.id, true, false) === "credits",
)!.id;

function fixture(mode: string, personal: boolean) {
  vi.stubEnv("PI_DEFAULT_PROVIDER", provider);
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-deployment-key");
  const credential = {
    id: "fixture-credential",
    provider,
    secretId: "fixture-secret",
    userId: scope.userId,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultModel: unpriced,
  };
  const load = vi.fn().mockResolvedValue("fixture-personal-key");
  const transaction = vi.fn();
  const prisma = {
    userModelPreference: {
      findFirst: async () => (personal ? { credential, modelId: unpriced } : null),
      findMany: async () => [],
    },
    userModelCredential: {
      findFirst: async () => (personal ? credential : null),
      findMany: async () => (personal ? [credential] : []),
    },
    secret: {
      findFirst: async () => ({ id: credential.secretId, ciphertext: "fixture-ciphertext" }),
      findMany: async () => [{ id: credential.secretId, ciphertext: "fixture-ciphertext" }],
    },
    space: {
      findFirst: async () => ({ organization: { modelCredits: { mode, balanceMicros: 0n } } }),
      findUnique: async () => ({ organizationId: "fixture-org" }),
    },
    member: { findUnique: async () => ({ role: "owner" }) },
    modelCreditAccount: { upsert: async () => ({ mode, balanceMicros: 0n }) },
    $transaction: transaction,
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secretStore: { load },
    billingEnabled: true,
    deploymentModelKey: "fixture-deployment-key",
  } as unknown as ExecutorDeps;
  return { prisma, deps, credential: personal ? credential : null, load, transaction };
}

afterEach(() => vi.unstubAllEnvs());

describe("unpriced model funding", () => {
  it("rejects unknown prices at reservation before touching the ledger", async () => {
    const { prisma, transaction } = fixture("credits", false);
    await expect(reserveModelCredits(prisma, "fixture-org", Number.NaN)).rejects.toThrow(
      "reliable price",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects credits-only selection, bot pins, and execution and hides the model", async () => {
    const { prisma, deps, transaction } = fixture("credits", false);
    expect(
      await validateConnectedModelChoice(prisma, deps.secretStore, scope, provider, unpriced, {
        hostedProvider: provider,
      }),
    ).toBe("Connect your own API key to use this model.");
    const result = await validateBotModelChange(
      {
        prisma,
        secretStore: deps.secretStore,
        hostedProvider: provider,
        refreshExpiredCredential: vi.fn(),
        defaultModel: async () => ({ provider: null, model: null }),
      },
      { ...scope, provider, model: unpriced },
    );
    expect(result.ok).toBe(false);
    await expect(
      resolveModelKey(deps, scope.userId, scope.spaceId, null, provider, unpriced),
    ).rejects.toThrow("Connect your own API key");
    const catalog = await connectedModelChoices(
      { prisma, secretStore: deps.secretStore, hostedProvider: provider },
      scope,
    );
    expect(catalog.some((entry) => entry.provider === provider && entry.id === unpriced)).toBe(
      false,
    );
    expect(catalog.some((entry) => entry.provider === provider && entry.id === priced)).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["byok", "credits"])(
    "uses the member key for an unpriced model in %s mode",
    async (mode) => {
      const { prisma, deps, credential, transaction } = fixture(mode, true);
      expect(
        await validateConnectedModelChoice(prisma, deps.secretStore, scope, provider, unpriced, {
          hostedProvider: provider,
        }),
      ).toBeUndefined();
      const resolved = await resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        credential,
        provider,
        unpriced,
      );
      expect(resolved.apiKey).toBe("fixture-personal-key");
      expect(resolved.ownCredential).toBe(true);
      expect(resolved.callObserver).toBeUndefined();
      expect(transaction).not.toHaveBeenCalled();
      const catalog = await connectedModelChoices(
        { prisma, secretStore: deps.secretStore, hostedProvider: provider },
        scope,
      );
      expect(catalog.some((entry) => entry.provider === provider && entry.id === unpriced)).toBe(
        true,
      );
    },
  );

  it("uses a member key for an unpriced model from another provider", async () => {
    const { deps, credential, transaction } = fixture("credits", true);
    const own = { ...credential!, provider: "openai" };
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      own,
      own.provider,
      "fixture-unpriced",
    );
    expect(resolved.apiKey).toBe("fixture-personal-key");
    expect(resolved.callObserver).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("finds the member key for an unpriced deployment default", async () => {
    const { deps } = fixture("credits", true);
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      null,
      provider,
      unpriced,
    );
    expect(resolved.apiKey).toBe("fixture-personal-key");
    expect(resolved.callObserver).toBeUndefined();
  });

  it("keeps priced models on credits with a member key connected", async () => {
    const { deps, credential, load } = fixture("credits", true);
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      credential,
      provider,
      priced,
    );
    expect(resolved.apiKey).toBe("fixture-deployment-key");
    expect(resolved.callObserver).toBeDefined();
    expect(load).not.toHaveBeenCalled();
  });
});
