import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedModelCreditMaterial } from "./model-credit-routing.js";

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
