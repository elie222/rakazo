import type * as Adapters from "@rakazo/adapters";
import {
  EncryptedSecretStore,
  SHARED_DEPLOYMENT_MODEL_RECORD,
  testSharedModel,
} from "@rakazo/adapters";
import type { Actor, SharedModelInput } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { configureSharedModel, sharedModelSettings } from "./shared-deployment-model.js";

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  testSharedModel: vi.fn(),
}));

const actor = {
  userId: "member",
  spaceId: "space",
} as Actor;

function fixture() {
  const findUnique = vi.fn().mockResolvedValue({ email: "admin@rakazo.test", emailVerified: true });
  const deployment = {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
      deployment.findUnique.mockResolvedValue(create);
      return create;
    }),
  };
  const tx = { user: { findUnique }, deploymentModelConnection: deployment };
  const prisma = { ...tx, $transaction: async (work: (db: typeof tx) => unknown) => work(tx) };
  const secrets = new EncryptedSecretStore("fake-test-key");
  const publishDeploymentModelChange = vi.fn(async () => undefined);
  const deps = {
    prisma,
    events: { publishDeploymentModelChange },
    secrets,
    env: { adminEmails: ["admin@rakazo.test"] },
  } as unknown as RouterDeps;
  const input = {
    provider: "anthropic",
    modelId: "fixture-model",
    method: "api_key",
    apiKey: "fixture-private-api-key",
  } satisfies SharedModelInput;
  return { deps, deployment, input, secrets, findUnique, publishDeploymentModelChange };
}

describe("admin-managed deployment model", () => {
  beforeEach(() => vi.mocked(testSharedModel).mockReset().mockResolvedValue(undefined));

  it("persists a tested credential sealed and sends only metadata to the admin", async () => {
    const { deps, deployment, input, secrets } = fixture();
    await configureSharedModel(deps, actor, input);
    const row = deployment.upsert.mock.calls[0]![0].create;
    expect(row).toMatchObject({
      provider: input.provider,
      modelId: input.modelId,
    });
    expect(row.revision).toEqual(expect.any(String));
    expect(JSON.stringify(row)).not.toContain(input.apiKey);
    await expect(
      secrets.load(String(row.credentialCipher), SHARED_DEPLOYMENT_MODEL_RECORD),
    ).resolves.toBe(input.apiKey);
    const visible = await sharedModelSettings(deps, actor);
    expect(visible.connection).toEqual({
      provider: input.provider,
      modelId: input.modelId,
      method: input.method,
    });
    expect(JSON.stringify(visible)).not.toContain(String(row.credentialCipher));
  });

  it("preserves the active credential after a failed replacement and disconnects on request", async () => {
    const { deps, deployment, input, publishDeploymentModelChange } = fixture();
    await configureSharedModel(deps, actor, input);
    vi.mocked(testSharedModel).mockRejectedValueOnce(new Error("Provider rejected the model"));
    await expect(
      configureSharedModel(deps, actor, { ...input, modelId: "unknown" }),
    ).rejects.toThrow("Provider rejected");
    expect(deployment.upsert).toHaveBeenCalledOnce();
    expect(publishDeploymentModelChange).toHaveBeenCalledOnce();
    expect(publishDeploymentModelChange).toHaveBeenCalledAfter(deployment.upsert);
    await configureSharedModel(deps, actor, null);
    expect(publishDeploymentModelChange).toHaveBeenCalledTimes(2);
    expect((await sharedModelSettings(deps, actor)).connection).toBeNull();
  });

  it("rechecks verified admin status after provider testing", async () => {
    const { deps, deployment, input, findUnique } = fixture();
    findUnique.mockResolvedValueOnce({ email: "admin@rakazo.test", emailVerified: true });
    findUnique.mockResolvedValue({ email: "admin@rakazo.test", emailVerified: false });
    await expect(configureSharedModel(deps, actor, input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(deployment.upsert).not.toHaveBeenCalled();
  });
});
