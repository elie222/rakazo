import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { runModelBackups, startRunModel } from "./run-model-start.js";

it("starts on the authorized organization key without hosted model access", async () => {
  const load = vi.fn(async () => "fixture-organization-key");
  const deps = {
    prisma: {
      organizationModelConnection: {
        findFirst: async () => ({ secretId: "fixture", ciphertext: "sealed" }),
      },
      spaceMember: {
        findUnique: async () => ({
          member: { role: "member", organization: { modelCredits: null, billing: null } },
        }),
      },
    },
    secretStore: { load },
    billingEnabled: true,
  } as unknown as ExecutorDeps;
  const run = { id: "run", userId: "user", spaceId: "space", modelPinned: false };
  const backups = runModelBackups(deps, run, {}, false, vi.fn(), true);
  const result = await startRunModel(
    deps,
    run,
    {
      provider: "openai",
      id: "fixture-model",
      credential: null,
      thinkingLevel: null,
      connectionId: "organization:shared",
    },
    undefined,
    backups,
    vi.fn(),
  );
  expect(result.start?.resolved).toMatchObject({
    apiKey: "fixture-organization-key",
    billing: "organization",
  });
  await expect(backups.load()).resolves.toEqual([]);
});

it("fails a removed organization selection before reading saved personal backups", async () => {
  const findPersonalChoices = vi
    .fn()
    .mockResolvedValue([{ provider: "openai", modelId: "fixture-backup", position: 1 }]);
  const deps = {
    prisma: {
      organizationModelConnection: { findFirst: async () => null },
      userModelRoleChoice: { findMany: findPersonalChoices },
      spaceSettingOverride: { findUnique: async () => null },
    },
    billingEnabled: false,
  } as unknown as ExecutorDeps;
  const run = { id: "run", userId: "user", spaceId: "space", modelPinned: false };
  const backups = runModelBackups(deps, run, {}, false, vi.fn(), true);
  const result = await startRunModel(
    deps,
    run,
    {
      provider: "openai",
      id: "fixture-model",
      credential: null,
      thinkingLevel: null,
      connectionId: "organization:removed",
    },
    undefined,
    backups,
    vi.fn(),
  );
  expect(result.failure?.message).toBe(
    "Choose an available organization model or switch to your saved model.",
  );
  expect(findPersonalChoices).not.toHaveBeenCalled();
});

it("refuses a revoked personal pin without opening the active Space key or reserving credits", async () => {
  const organizationLookup = vi.fn(async () => ({ secretId: "org", ciphertext: "org-sealed" }));
  const load = vi.fn(async () => "fixture-organization-key");
  const readBackups = vi.fn();
  const reserve = vi.fn();
  const deps = {
    prisma: {
      organizationModelConnection: { findFirst: organizationLookup },
      spaceMember: {
        findUnique: async () => ({
          member: {
            role: "member",
            organization: { modelCredits: null, billing: { status: "active" } },
          },
        }),
      },
      secret: { findFirst: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: readBackups },
      modelCreditAccount: { updateMany: reserve },
    },
    secretStore: { load },
    billingEnabled: true,
  } as unknown as ExecutorDeps;
  const run = { id: "run", userId: "user", spaceId: "space", modelPinned: false };
  const model = { provider: "openai", id: "fixture-model", thinkingLevel: null };
  const createBackups = () => runModelBackups(deps, run, {}, false, vi.fn(), true);
  const pin = {
    id: "personal",
    provider: "openai",
    userId: "user",
    secretId: "revoked",
  } as NonNullable<Parameters<typeof startRunModel>[2]["credential"]>;
  const failed = await startRunModel(
    deps,
    run,
    { ...model, credential: pin, connectionId: pin.id },
    undefined,
    createBackups(),
    vi.fn(),
  );
  expect(failed.start).toBeUndefined();
  expect(failed.failure?.message).toBe("Connect that model provider again.");
  expect(organizationLookup).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(readBackups).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();

  const inherited = await startRunModel(
    deps,
    run,
    { ...model, credential: null, connectionId: "organization:shared" },
    undefined,
    createBackups(),
    vi.fn(),
  );
  expect(inherited.start?.resolved).toMatchObject({
    apiKey: "fixture-organization-key",
    billing: "organization",
  });
  expect(organizationLookup).toHaveBeenCalledOnce();
  expect(reserve).not.toHaveBeenCalled();
});
