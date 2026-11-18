import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableModel,
  owner,
  setupModelSettings as setup,
} from "./model-settings.test-support.js";

it("persists an explicit approved credit route alongside the personal route", async () => {
  const { call, deps, roles, prisma } = setup();
  deps.billing = { modelCreditsEnabled: true } as never;
  const offering = {
    id: "offering-example",
    connectionId: "operator-example",
    provider: availableModel.provider,
    modelId: availableModel.id,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
  };
  const operatorConnection = vi.fn(async () => ({
    id: offering.connectionId,
    provider: offering.provider,
    userId: "operator-example",
    secretId: "operator-secret",
  }));
  Object.assign(prisma.userModelCredential, { findUnique: operatorConnection });
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
  );
  try {
    const credit = {
      provider: offering.provider,
      modelId: offering.modelId,
      creditOfferingId: offering.id,
    };
    const personal = {
      provider: offering.provider,
      modelId: offering.modelId,
      credentialId: "credential-one",
    };
    const catalog = (await (await call("models/forRole", { role: "main" })).response.json()).json;
    expect(catalog).toContainEqual(
      expect.objectContaining({ id: offering.modelId, creditOfferingId: offering.id }),
    );
    expect(
      (await call("models/setRole", { role: "main", primary: credit, backups: [personal] }))
        .response.status,
    ).toBe(200);
    expect(roles()).toEqual([
      expect.objectContaining({ ...credit, credentialId: null }),
      expect.objectContaining({ ...personal, creditOfferingId: null }),
    ]);
    expect(
      (
        await call("models/setRole", {
          role: "main",
          primary: { ...credit, credentialId: personal.credentialId },
        })
      ).response.status,
    ).toBe(400);
    const refused = await call("models/setRole", {
      role: "main",
      primary: { ...credit, creditOfferingId: "unapproved" },
    });
    expect(refused.response.status).toBe(400);
    expect(await refused.response.json()).toMatchObject({
      json: { code: "MODEL_CREDIT_OFFERING_UNAVAILABLE" },
    });
    operatorConnection.mockResolvedValue(null as never);
    const unavailableCatalog = (
      await (await call("models/forRole", { role: "main" })).response.json()
    ).json;
    expect(unavailableCatalog).toContainEqual(expect.objectContaining({ id: offering.modelId }));
    expect(
      unavailableCatalog.some(
        (entry: { creditOfferingId?: string }) => entry.creditOfferingId === offering.id,
      ),
    ).toBe(false);
    expect((await call("models/setRole", { role: "main", primary: credit })).response.status).toBe(
      400,
    );
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({ defaultOfferingId: null, offerings: [] }),
    );
    expect((await call("models/setRole", { role: "main", primary: credit })).response.status).toBe(
      400,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  { images: true, personal: false },
  { images: true, personal: true },
  { images: false, personal: true },
])(
  "uses the funded live model's image setting (images=$images, personal=$personal)",
  async ({ images, personal }) => {
    const { call, deps, prisma, roles } = setup({
      credits: !personal,
      credentialProvider: "openai",
    });
    deps.billing = { modelCreditsEnabled: true } as never;
    const offering = {
      id: "future-approved",
      connectionId: "operator-example",
      provider: "openai",
      modelId: "gpt-future-credit-test",
      price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    };
    Object.assign(prisma.userModelCredential, {
      findUnique: vi.fn(async () => ({
        id: offering.connectionId,
        provider: offering.provider,
        userId: "operator-example",
        secretId: "operator-secret",
      })),
    });
    Object.assign(prisma.secret, {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        ciphertext: where.id === "operator-secret" ? "operator-fixture" : "personal-fixture",
      })),
    });
    vi.mocked(deps.secrets.load).mockImplementation(async (ciphertext) =>
      JSON.stringify({
        kind: "api_key",
        key: "fake-key",
        models: {
          [offering.modelId]: {
            images: ciphertext === "operator-fixture" ? images : !images,
            reasoning: true,
            contextWindow: 32000,
            maxTokens: 4000,
          },
        },
      }),
    );
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
    );
    try {
      const catalog = (await (await call("models/forRole", { role: "main" })).response.json()).json;
      expect(catalog).toContainEqual(
        expect.objectContaining({
          id: offering.modelId,
          provider: offering.provider,
          creditOfferingId: offering.id,
          live: true,
          images,
          reasoning: true,
          contextWindow: 32000,
          maxTokens: 4000,
        }),
      );
      const primary = {
        provider: offering.provider,
        modelId: offering.modelId,
        creditOfferingId: offering.id,
      };
      vi.mocked(deps.secrets.load).mockClear();
      const saved = await call("models/setRole", { role: "main", primary });
      expect(saved.response.status).toBe(200);
      expect((await saved.response.json()).json.seesImages).toBe(images);
      expect(
        vi
          .mocked(deps.secrets.load)
          .mock.calls.filter(([ciphertext]) => ciphertext === "operator-fixture"),
      ).toHaveLength(1);
      const read = await call("models/role", { role: "main" });
      expect((await read.response.json()).json.seesImages).toBe(images);
      expect(roles()).toEqual([expect.objectContaining({ ...primary, credentialId: null })]);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("offers a ready decision credit route independently of the reasoning catalog", async () => {
  const { call, deps, prisma } = setup();
  deps.billing = { modelCreditsEnabled: true } as never;
  const offering = {
    id: "decision-example",
    connectionId: "operator-example",
    provider: "openrouter",
    modelId: "typesafe/jev-1.14",
    price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  Object.assign(prisma.userModelCredential, {
    findUnique: vi.fn(async () => ({
      id: offering.connectionId,
      userId: "operator-example",
      provider: offering.provider,
      secretId: "operator-secret",
    })),
  });
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
  );
  try {
    const response = await call("models/forRole", { role: "approval" });
    expect(response.response.status).toBe(200);
    expect((await response.response.json()).json).toContainEqual(
      expect.objectContaining({ id: offering.modelId, creditOfferingId: offering.id }),
    );
    expect(
      (
        await call("models/setRole", {
          role: "approval",
          primary: {
            provider: offering.provider,
            modelId: offering.modelId,
            creditOfferingId: offering.id,
          },
        })
      ).response.status,
    ).toBe(200);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the legacy hosted decision checker selectable without a personal key", async () => {
  const { call } = setup({ credits: true });
  vi.stubEnv("MODEL_CREDIT_OFFERINGS", undefined);
  vi.stubEnv("OPENROUTER_API_KEY", "fake-operator-key");
  try {
    const response = await call("models/forRole", { role: "approval" });
    expect(response.response.status).toBe(200);
    const catalog = (await response.response.json()).json;
    const decision = adapters.decisionModelCatalog()[0]!;
    expect(catalog).toContainEqual(
      expect.objectContaining({
        provider: decision.provider,
        id: decision.id,
        protocol: "decisions",
        managed: true,
      }),
    );
    const saved = await call("models/setRole", {
      role: "approval",
      primary: { provider: decision.provider, modelId: decision.id },
    });
    expect(saved.response.status).toBe(200);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("legacy backup funding compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());
  const offering = {
    id: "legacy-offering",
    connectionId: "operator-example",
    provider: availableModel.provider,
    modelId: availableModel.id,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  function configure(f: ReturnType<typeof setup>) {
    f.deps.billing = { modelCreditsEnabled: true } as never;
    Object.assign(f.prisma.userModelCredential, {
      findUnique: vi.fn(async () => ({
        id: offering.connectionId,
        userId: "operator-example",
        provider: offering.provider,
        secretId: "operator-secret",
      })),
    });
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
    );
  }
  it.each([false, true])(
    "preserves a credit route through a legacy backup round-trip (explicit=%s)",
    async (explicit) => {
      const f = setup({
        credits: true,
        existing: [
          {
            userId: owner.userId,
            provider: offering.provider,
            modelId: offering.modelId,
            creditOfferingId: offering.id,
            position: 0,
          },
        ],
      });
      configure(f);
      const response = await f.call("models/backups", null);
      expect((await response.response.json()).json).toEqual([
        { provider: offering.provider, modelId: offering.modelId, creditOfferingId: offering.id },
      ]);
      const input = [
        {
          provider: offering.provider,
          modelId: offering.modelId,
          ...(explicit ? { creditOfferingId: offering.id } : {}),
        },
      ];
      expect((await f.call("models/setBackups", input)).response.status).toBe(200);
      expect(f.roles()).toEqual([
        expect.objectContaining({ creditOfferingId: offering.id, credentialId: null }),
      ]);
      expect(f.deps.secrets.load).toHaveBeenCalledOnce();
    },
  );
  it("rejects an ambiguous funding-free update before changing saved rows", async () => {
    const f = setup({
      existing: [
        {
          userId: owner.userId,
          provider: offering.provider,
          modelId: offering.modelId,
          creditOfferingId: offering.id,
          position: 0,
        },
        {
          userId: owner.userId,
          provider: offering.provider,
          modelId: offering.modelId,
          credentialId: "credential-one",
          position: 1,
        },
      ],
    });
    configure(f);
    const response = await f.call("models/setBackups", [
      { provider: offering.provider, modelId: offering.modelId },
    ]);
    expect(response.response.status).toBe(409);
    expect(f.userModelRoleChoice.createMany).not.toHaveBeenCalled();
  });
  it.each([new Error("fake-decryption-failure"), new SecretStoreUnavailableError(503)])(
    "keeps personal models available when the operator secret is unavailable",
    async (error) => {
      const f = setup();
      configure(f);
      Object.assign(f.prisma.secret, {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id === "operator-secret" ? "broken-operator" : "personal-fixture",
        })),
      });
      vi.mocked(f.deps.secrets.load).mockImplementation(async (ciphertext) => {
        if (ciphertext === "broken-operator") throw error;
        return JSON.stringify({ kind: "api_key", key: "fake-personal-key" });
      });
      const response = await f.call("models/forRole", { role: "main" });
      expect(response.response.status).toBe(200);
      const catalog = (await response.response.json()).json;
      expect(catalog).toContainEqual(
        expect.objectContaining({ provider: offering.provider, id: offering.modelId }),
      );
      expect(catalog.some((entry: { creditOfferingId?: string }) => entry.creditOfferingId)).toBe(
        false,
      );
    },
  );
});
