import type * as Db from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { resolveConnectedModelKey, resolveModelKey } from "./run-model.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  organizationForMember: async () => ({ organizationId: "organization-example" }),
  creditAccount: async () => ({ mode: "credits", balanceMicros: 1000000n }),
}));
const scope = { userId: "member-example", spaceId: "space-example" };
const offering = {
  id: "offering-example",
  connectionId: "operator-connection",
  provider: "anthropic",
  modelId: "approved-model",
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
};
function setup() {
  vi.stubEnv(
    "MODEL_CREDIT_OFFERINGS",
    JSON.stringify({ defaultOfferingId: offering.id, offerings: [offering] }),
  );
  const personal = {
    id: "personal-connection",
    secretId: "personal-secret",
    provider: offering.provider,
  };
  const findUnique = vi.fn(async () => ({
    id: offering.connectionId,
    provider: offering.provider,
    userId: "operator-example",
    secretId: "operator-secret",
  }));
  const findFirst = vi.fn(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    ciphertext: where.id,
  }));
  const load = vi.fn(async (sealed: string) =>
    JSON.stringify({
      kind: "api_key",
      key: sealed === "operator-secret" ? "fake-operator-key" : "fake-personal-key",
    }),
  );
  const deps = {
    billingEnabled: true,
    prisma: {
      userModelCredential: { findUnique, findFirst: vi.fn(async () => personal) },
      space: {
        findFirst: vi.fn(async () => ({
          organization: { modelCredits: { mode: "credits", balanceMicros: 1000000n } },
        })),
      },
      secret: { findFirst },
    },
    secretStore: { load },
  } as unknown as ExecutorDeps;
  return { deps, personal, load, findUnique, findFirst };
}
afterEach(() => vi.unstubAllEnvs());
describe("explicit model credit funding", () => {
  it("uses the approved deployment connection even when a personal connection exists", async () => {
    const { deps, load } = setup();
    const { credential, resolved } = await resolveConnectedModelKey(
      deps,
      scope,
      offering.provider,
      offering.modelId,
      undefined,
      true,
      `credits:${offering.id}`,
    );
    expect(credential).toBeNull();
    expect(resolved).toMatchObject({
      apiKey: "fake-operator-key",
      connectionId: `credits:${offering.id}`,
      callObserver: expect.any(Object),
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("operator-secret", "operator-secret");
  });
  it("never meters a personal call to the same provider/model", async () => {
    const { deps, personal, findUnique } = setup();
    const result = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      personal,
      offering.provider,
      offering.modelId,
    );
    expect(result).toMatchObject({
      apiKey: "fake-personal-key",
      connectionId: personal.id,
      ownCredential: true,
    });
    expect(result.callObserver).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });
  it.each([
    { model: "unapproved-model", id: offering.id },
    { model: offering.modelId, id: "withdrawn-offering" },
  ])("refuses changed model or offering before loading a credential", async ({ model, id }) => {
    const { deps, load } = setup();
    await expect(
      resolveConnectedModelKey(
        deps,
        scope,
        offering.provider,
        model,
        undefined,
        true,
        `credits:${id}`,
      ),
    ).rejects.toThrow("unavailable");
    expect(load).not.toHaveBeenCalled();
  });
  it("fails a missing personal secret without switching to credits", async () => {
    const { deps, personal, findFirst, findUnique } = setup();
    findFirst.mockResolvedValue(null as never);
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        personal,
        offering.provider,
        offering.modelId,
      ),
    ).rejects.toThrow("again");
    expect(findUnique).not.toHaveBeenCalled();
  });
  it("never turns a missing pinned personal connection into deployment funding", async () => {
    const { deps, load } = setup();
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        offering.provider,
        offering.modelId,
        undefined,
        { requireStoredSecret: true },
      ),
    ).rejects.toThrow("personal connection");
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects contradictory personal and credit funding", async () => {
    const { deps, personal, load } = setup();
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        personal,
        offering.provider,
        offering.modelId,
        undefined,
        { creditOfferingId: offering.id },
      ),
    ).rejects.toThrow("unavailable");
    expect(load).not.toHaveBeenCalled();
  });
});
