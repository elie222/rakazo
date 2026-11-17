import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvedModelCreditMaterial,
  availableModelCreditOfferings,
} from "./model-credit-routing.js";

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
afterEach(() => vi.unstubAllEnvs());
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
  it("refuses an unapproved model before reading any credential", async () => {
    const deps = setup();
    await expect(
      approvedModelCreditMaterial(
        deps.prisma as never,
        deps.secrets,
        offering.provider,
        "unapproved-model",
      ),
    ).rejects.toThrow("personal connection");
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
it("propagates secret-store outages rather than reporting healthy configuration", async () => {
  const deps = setup();
  const outage = new Error("Secret store unavailable");
  deps.load.mockRejectedValue(outage);
  await expect(availableModelCreditOfferings(deps.prisma as never, deps.secrets)).rejects.toBe(
    outage,
  );
});
