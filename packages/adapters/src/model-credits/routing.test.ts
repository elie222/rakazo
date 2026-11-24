import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvedModelCreditCatalogEntry,
  approvedModelCreditMaterial,
  availableModelCreditOfferings,
  ModelCreditConnectionUnavailableError,
  modelCreditUsageLookup,
} from "./routing.js";

vi.mock("@rakazo/db", () => ({ runAsSystem: (_label: string, work: () => unknown) => work() }));
const offering = {
  id: "approved",
  connectionId: "operator-connection",
  provider: "anthropic",
  modelId: "approved-model",
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
};
function setup(provider = offering.provider, secret = { kind: "api_key", key: "fake-key" }) {
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
  );
  const findUnique = vi.fn(async () => ({
    id: offering.connectionId,
    provider,
    userId: "operator",
    secretId: "operator-secret",
  }));
  const findFirst = vi.fn(async () => ({ id: "operator-secret", ciphertext: "fake-sealed" }));
  const load = vi.fn(async () => JSON.stringify(secret));
  const prisma = { userModelCredential: { findUnique }, secret: { findFirst } };
  return { prisma, secrets: { load }, findUnique, findFirst, load };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("approved credit connection routing", () => {
  it("loads only the configured connection and its owner-scoped secret", async () => {
    const deps = setup();
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        offering.modelId,
      ),
    ).resolves.toMatchObject({ apiKey: "fake-key" });
    expect(deps.findUnique).toHaveBeenCalledWith({ where: { id: "operator-connection" } });
    expect(deps.findFirst).toHaveBeenCalledWith({
      where: { id: "operator-secret", userId: "operator", spaceId: null },
    });
  });
  it("runs a credit-funded model at the level its stored connection saved for it", async () => {
    const deps = setup(offering.provider, {
      kind: "api_key",
      key: "fake-key",
      models: { [offering.modelId]: { reasoning: true, thinkingLevel: "high" } },
    } as never);
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        offering.modelId,
      ),
    ).resolves.toMatchObject({ reasoning: true, thinkingLevel: "high" });
  });
  it("carries zero data retention from the stored connection to the credit-funded run", async () => {
    const deps = setup("openrouter", {
      kind: "api_key",
      key: "fake-key",
      zeroDataRetention: true,
    } as never);
    vi.stubEnv(
      "MODEL_CREDIT_OFFERINGS",
      JSON.stringify({
        defaultOfferingId: offering.id,
        offerings: [{ ...offering, provider: "openrouter" }],
      }),
    );
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        "openrouter",
        offering.modelId,
      ),
    ).resolves.toMatchObject({ zeroDataRetention: true });
  });
  it("refuses an unapproved model before reading any credential", async () => {
    const deps = setup();
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        "unapproved-model",
      ),
    ).rejects.toBeInstanceOf(ModelCreditConnectionUnavailableError);
    expect(deps.findUnique).not.toHaveBeenCalled();
  });
  it("never routes a key to another provider", async () => {
    const deps = setup("other-provider");
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        offering.modelId,
      ),
    ).rejects.toThrow("unavailable");
    expect(deps.load).not.toHaveBeenCalled();
  });
  it("refuses custom endpoint credentials", async () => {
    const deps = setup(offering.provider, {
      kind: "openai_compatible",
      baseUrl: "https://models.example.test",
      apiKey: "fake-key",
    } as never);
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        offering.modelId,
      ),
    ).rejects.toThrow("requires an API key");
  });
});

it.each([
  "missing-connection",
  "wrong-provider",
  "missing-secret",
  "wrong-kind",
  "blank-key",
  "corrupt-secret",
])("hides an unavailable approved connection: %s", async (reason) => {
  const deps = setup(reason === "wrong-provider" ? "other-provider" : offering.provider);
  if (reason === "missing-connection") deps.findUnique.mockResolvedValue(null as never);
  if (reason === "missing-secret") deps.findFirst.mockResolvedValue(null as never);
  if (reason === "wrong-kind")
    deps.load.mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://models.example.test",
        apiKey: "fake-key",
      }),
    );
  if (reason === "blank-key")
    deps.load.mockResolvedValue(JSON.stringify({ kind: "api_key", key: " " }));
  if (reason === "corrupt-secret")
    deps.load.mockResolvedValue(JSON.stringify({ kind: "oauth", credential: null }));
  expect(await availableModelCreditOfferings(deps.prisma as never, deps.secrets)).toEqual([]);
});
it("shares a connection read across approved models and checks it again on the next catalog read", async () => {
  const deps = setup();
  const second = { ...offering, id: "second", modelId: "second-model" };
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering, second] }),
  );
  expect(await availableModelCreditOfferings(deps.prisma as never, deps.secrets)).toEqual([
    offering,
    second,
  ]);
  expect(deps.load).toHaveBeenCalledOnce();
  deps.findUnique.mockResolvedValue(null as never);
  expect(await availableModelCreditOfferings(deps.prisma as never, deps.secrets)).toEqual([]);
});
it.each([
  new Error("fake-decrypt-failure"),
  new SecretStoreUnavailableError(503, "fake-store-outage"),
])("hides an unavailable operator secret without failing catalog reads", async (error) => {
  const deps = setup();
  deps.load.mockRejectedValue(error);
  expect(await availableModelCreditOfferings(deps.prisma as never, deps.secrets)).toEqual([]);
  await expect(
    approvedModelCreditMaterial(
      deps.prisma as never,
      deps.secrets,
      offering.provider,
      offering.modelId,
    ),
  ).rejects.toThrow(
    error instanceof SecretStoreUnavailableError ? "fake-store-outage" : "unavailable",
  );
});
it("shares operator reads across listing and live metadata within one request only", async () => {
  const deps = setup("openai");
  const live = { ...offering, provider: "openai", modelId: "gpt-future-credit-test" };
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: live.id, offerings: [live] }),
  );
  const reads = new Map();
  await availableModelCreditOfferings(deps.prisma as never, deps.secrets, { reads });
  expect(
    await approvedModelCreditCatalogEntry(
      deps.prisma as never,
      deps.secrets,
      live.provider,
      live.modelId,
      reads,
    ),
  ).toMatchObject({ id: live.modelId });
  expect(deps.load).toHaveBeenCalledOnce();
  await availableModelCreditOfferings(deps.prisma as never, deps.secrets);
  expect(deps.load).toHaveBeenCalledTimes(2);
});
it("does not load offerings for providers outside the member's funding", async () => {
  const deps = setup();
  expect(
    await availableModelCreditOfferings(deps.prisma as never, deps.secrets, {
      providers: new Set(),
    }),
  ).toEqual([]);
  expect(deps.findUnique).not.toHaveBeenCalled();
});

it("reports invalid operator secrets without logging credential values", async () => {
  const deps = setup();
  deps.load.mockResolvedValue(
    JSON.stringify({ kind: "oauth", credential: null, key: "fake-sensitive-key" }),
  );
  const sink = createTestSink();
  const previous = getLogger();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  try {
    expect(await availableModelCreditOfferings(deps.prisma as never, deps.secrets)).toEqual([]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "warn",
      message: "approved model credit connection has an invalid stored secret",
    });
    expect(JSON.stringify(sink.events)).toContain(offering.id);
    expect(JSON.stringify(sink.events)).not.toContain("fake-sensitive-key");
    expect(JSON.stringify(sink.events)).not.toContain('"credential":null');
  } finally {
    installLogger(previous);
  }
});

it("recovers through the saved connection after withdrawal without using an environment key", async () => {
  const deps = setup("openrouter");
  const saved = { ...offering, provider: "openrouter" };
  vi.stubEnv("MODEL_CREDIT_OFFERINGS", JSON.stringify({ defaultOfferingId: null, offerings: [] }));
  vi.stubEnv("OPENROUTER_API_KEY", "fake-wrong-environment-key");
  const fetcher = vi.fn(async () =>
    Response.json({
      data: {
        id: "gen-recovery",
        total_cost: 0,
        native_tokens_prompt: 100,
        native_tokens_completion: 10,
        native_tokens_cached: 0,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const lookup = await modelCreditUsageLookup(deps.prisma as never, deps.secrets, saved);
  expect(await lookup!.lookupUsage("gen-recovery")).toMatchObject({
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0,
  });
  expect(fetcher).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: { Authorization: "Bearer fake-key" } }),
  );
  expect(deps.findUnique).toHaveBeenCalledWith({ where: { id: offering.connectionId } });
});
it("does not read a connection for a provider without recovery support", async () => {
  const deps = setup();
  expect(
    await modelCreditUsageLookup(deps.prisma as never, deps.secrets, offering),
  ).toBeUndefined();
  expect(deps.findUnique).not.toHaveBeenCalled();
});
it("refuses recovery with a connection belonging to another provider", async () => {
  const deps = setup("anthropic");
  await expect(
    modelCreditUsageLookup(deps.prisma as never, deps.secrets, {
      ...offering,
      provider: "openrouter",
    }),
  ).rejects.toThrow("unavailable");
  expect(deps.load).not.toHaveBeenCalled();
});
it("keeps provider diagnostics that echo credentials out of recovery errors", async () => {
  const deps = setup("openrouter");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { message: "rejected fake-key" } }, { status: 400 })),
  );
  const lookup = await modelCreditUsageLookup(deps.prisma as never, deps.secrets, {
    ...offering,
    provider: "openrouter",
  });
  await expect(lookup!.lookupUsage("gen-recovery")).rejects.toThrow(
    /^Approved model usage lookup unavailable$/,
  );
});
