import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentModelSettingsDeps } from "./deployment-model-settings.js";
import {
  getDeploymentModelSettings,
  updateDeploymentModelSettings,
} from "./deployment-model-settings.js";

const admin: Actor = {
  userId: "admin-user",
  spaceId: "admin-space",
  email: "admin@rakazo.test",
  isDeploymentOwner: false,
};
const member: Actor = { ...admin, userId: "member-user", email: "member@rakazo.test" };

type Row = {
  defaultModelProvider: string | null;
  defaultModelId: string | null;
  deploymentModelCredentialCipher: string | null;
};

function setup(options: { row?: Row | null; credits?: boolean } = {}) {
  let row: Row | null = options.row ?? null;
  let sealed = 0;
  const deploymentSettings = {
    findUnique: vi.fn(async () => (row ? { ...row } : null)),
    upsert: vi.fn(async ({ update }: { update: Row }) => {
      row = { ...update };
      return row;
    }),
    update: vi.fn(async ({ data }: { data: Row }) => {
      row = { ...row!, ...data };
      return row;
    }),
  };
  const prisma = {
    deploymentSettings,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        email: where.id === admin.userId ? admin.email : member.email,
        emailVerified: true,
      })),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(prisma)),
  };
  const secrets = {
    put: vi.fn(async (_plaintext: string, _context: unknown, _options: unknown) => ({
      id: "record",
      ciphertext: `sealed-${++sealed}`,
    })),
    delete: vi.fn(async () => undefined),
    isRemote: () => false,
  };
  const modelConnectionCheck = vi.fn(async () => undefined);
  const deps = {
    prisma,
    secrets,
    jobs: {},
    billing: options.credits ? { modelCreditsEnabled: true } : undefined,
    modelConnectionCheck,
    env: { adminEmails: [admin.email] },
  } as unknown as DeploymentModelSettingsDeps;
  return { deps, secrets, modelConnectionCheck, row: () => row };
}

const choice = { provider: "anthropic", modelId: "claude-sonnet-5" };

afterEach(() => vi.unstubAllEnvs());

describe("the model an admin sets for everyone", () => {
  it("is for admins only", async () => {
    const { deps, secrets } = setup();
    await expect(getDeploymentModelSettings(deps, member)).rejects.toThrow("Admins only");
    await expect(
      updateDeploymentModelSettings(deps, member, { ...choice, apiKey: "fake-admin-key" }),
    ).rejects.toThrow("Admins only");
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("checks and seals the key, and never returns it", async () => {
    const { deps, secrets, modelConnectionCheck, row } = setup();
    const settings = await updateDeploymentModelSettings(deps, admin, {
      ...choice,
      apiKey: "fake-admin-key",
    });
    expect(modelConnectionCheck).toHaveBeenCalledWith(
      { provider: "anthropic", id: "claude-sonnet-5", apiKey: "fake-admin-key" },
      expect.anything(),
    );
    expect(secrets.put).toHaveBeenCalledWith(
      JSON.stringify({ kind: "api_key", key: "fake-admin-key" }),
      expect.anything(),
      { recordId: "deployment-model" },
    );
    expect(row()).toEqual({
      defaultModelProvider: "anthropic",
      defaultModelId: "claude-sonnet-5",
      deploymentModelCredentialCipher: "sealed-1",
    });
    expect(settings).toMatchObject({ ...choice, keySaved: true });
    expect(JSON.stringify(settings)).not.toContain("fake-admin-key");
    expect(JSON.stringify(await getDeploymentModelSettings(deps, admin))).not.toContain("sealed");
  });

  it("keeps the saved key for another model of the same provider only", async () => {
    const { deps, secrets, row } = setup({
      row: {
        defaultModelProvider: "anthropic",
        defaultModelId: "claude-sonnet-5",
        deploymentModelCredentialCipher: "sealed-earlier",
      },
    });
    await updateDeploymentModelSettings(deps, admin, {
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      defaultModelId: "claude-haiku-5-5",
      deploymentModelCredentialCipher: "sealed-earlier",
    });
    await expect(
      updateDeploymentModelSettings(deps, admin, {
        provider: "deepseek",
        modelId: "deepseek-flash",
      }),
    ).rejects.toThrow("Enter an API key");
  });

  it("refuses a rejected key without echoing it", async () => {
    const { deps, modelConnectionCheck, secrets } = setup();
    modelConnectionCheck.mockRejectedValueOnce(new Error("bad key fake-admin-key"));
    const failure = updateDeploymentModelSettings(deps, admin, {
      ...choice,
      apiKey: "fake-admin-key",
    });
    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toThrow("fake-admin-key");
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("refuses a model the provider does not list and a provider the allowlist leaves out", async () => {
    const { deps } = setup();
    await expect(
      updateDeploymentModelSettings(deps, admin, {
        provider: "anthropic",
        modelId: "not-a-model",
        apiKey: "fake-admin-key",
      }),
    ).rejects.toThrow("Unknown model for this provider");
    await expect(
      updateDeploymentModelSettings(deps, admin, {
        provider: "openai-compatible",
        modelId: "custom",
        apiKey: "fake-admin-key",
      }),
    ).rejects.toThrow("Choose a provider that connects with a key");
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    await expect(
      updateDeploymentModelSettings(deps, admin, { ...choice, apiKey: "fake-admin-key" }),
    ).rejects.toThrow("This model provider is not allowed on this server.");
    expect(
      (await getDeploymentModelSettings(deps, admin)).providers.map((provider) => provider.id),
    ).toEqual(["openrouter"]);
  });

  it("offers nothing on a credits deployment, whose model is the operator's", async () => {
    const { deps } = setup({ credits: true });
    expect((await getDeploymentModelSettings(deps, admin)).providers).toEqual([]);
    await expect(
      updateDeploymentModelSettings(deps, admin, { ...choice, apiKey: "fake-admin-key" }),
    ).rejects.toThrow("This server's model is set by its operator");
  });

  it("goes back to the environment's model and removes the key", async () => {
    const { deps, secrets, row } = setup({
      row: {
        defaultModelProvider: "anthropic",
        defaultModelId: "claude-sonnet-5",
        deploymentModelCredentialCipher: "sealed-earlier",
      },
    });
    const settings = await updateDeploymentModelSettings(deps, admin, { provider: null });
    expect(row()).toEqual({
      defaultModelProvider: null,
      defaultModelId: null,
      deploymentModelCredentialCipher: null,
    });
    expect(secrets.delete).toHaveBeenCalledWith("sealed-earlier", "deployment-model");
    expect(settings).toMatchObject({ provider: null, modelId: null, keySaved: false });
  });

  it("leaves a default the environment saved without a key alone", async () => {
    const keyless = {
      defaultModelProvider: "openrouter",
      defaultModelId: "anthropic/claude-haiku-5.5",
      deploymentModelCredentialCipher: null,
    };
    const { deps, row } = setup({ row: keyless });
    expect(await getDeploymentModelSettings(deps, admin)).toMatchObject({
      provider: null,
      keySaved: false,
    });
    await updateDeploymentModelSettings(deps, admin, { provider: null });
    expect(row()).toEqual(keyless);
  });
});
