import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
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
  deploymentModelProvider: string | null;
  deploymentModelId: string | null;
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
    load: vi.fn(async (_ref: string, _context: unknown) =>
      JSON.stringify({ kind: "api_key", key: "fake-saved-key" }),
    ),
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
      deploymentModelProvider: "anthropic",
      deploymentModelId: "claude-sonnet-5",
      deploymentModelCredentialCipher: "sealed-1",
    });
    expect(settings).toMatchObject({ ...choice, keySaved: true });
    expect(JSON.stringify(settings)).not.toContain("fake-admin-key");
    expect(JSON.stringify(await getDeploymentModelSettings(deps, admin))).not.toContain("sealed");
  });

  it("keeps the saved key for another model of the same provider only", async () => {
    const { deps, secrets, row, modelConnectionCheck } = setup({
      row: {
        deploymentModelProvider: "anthropic",
        deploymentModelId: "claude-sonnet-5",
        deploymentModelCredentialCipher: "sealed-earlier",
      },
    });
    await updateDeploymentModelSettings(deps, admin, {
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
    });
    expect(secrets.put).not.toHaveBeenCalled();
    // The kept key is checked against the newly chosen model.
    expect(secrets.load).toHaveBeenCalledWith("sealed-earlier", "deployment-model");
    expect(modelConnectionCheck).toHaveBeenCalledWith(
      { provider: "anthropic", id: "claude-haiku-5-5", apiKey: "fake-saved-key" },
      expect.anything(),
    );
    expect(row()).toMatchObject({
      deploymentModelId: "claude-haiku-5-5",
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

  it("reports a cancelled save as cancelled, not as a rejected key", async () => {
    const { deps, modelConnectionCheck } = setup();
    const cancelled = new AbortController();
    const reason = new Error("Request cancelled");
    modelConnectionCheck.mockImplementationOnce(async () => {
      cancelled.abort(reason);
      throw reason;
    });
    await expect(
      updateDeploymentModelSettings(
        deps,
        admin,
        { ...choice, apiKey: "fake-admin-key" },
        cancelled.signal,
      ),
    ).rejects.toBe(reason);
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

  it("shows an inactive saved model as the environment's and keeps its key removable", async () => {
    const row = {
      deploymentModelProvider: "anthropic",
      deploymentModelId: "claude-sonnet-5",
      deploymentModelCredentialCipher: "sealed-earlier",
    };
    expect(await getDeploymentModelSettings(setup({ row }).deps, admin)).toMatchObject({
      provider: "anthropic",
      keySaved: true,
    });
    expect(
      await getDeploymentModelSettings(setup({ row, credits: true }).deps, admin),
    ).toMatchObject({ provider: null, modelId: null, keySaved: true });
    const retired = { ...row, deploymentModelId: "example-retired-model" };
    expect(await getDeploymentModelSettings(setup({ row: retired }).deps, admin)).toMatchObject({
      provider: null,
      modelId: null,
      keySaved: true,
    });
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    expect(await getDeploymentModelSettings(setup({ row }).deps, admin)).toMatchObject({
      provider: null,
      modelId: null,
      keySaved: true,
    });
  });

  it("audits committed changes without including the key", async () => {
    const record = vi.spyOn(db, "recordSecurityEvent").mockResolvedValue(undefined);
    try {
      const { deps } = setup();
      await updateDeploymentModelSettings(deps, admin, { provider: null });
      expect(record).not.toHaveBeenCalled();
      await updateDeploymentModelSettings(deps, admin, { ...choice, apiKey: "fake-admin-key" });
      await updateDeploymentModelSettings(deps, admin, choice);
      await updateDeploymentModelSettings(deps, admin, { ...choice, modelId: "claude-haiku-5-5" });
      await updateDeploymentModelSettings(deps, admin, { provider: null });
      await updateDeploymentModelSettings(deps, admin, { provider: null });
      expect(record.mock.calls.map(([event]) => event)).toEqual(
        ["created", "changed", "deleted"].map((verb) => ({
          type: `credential.${verb}`,
          userId: admin.userId,
          spaceId: admin.spaceId,
          metadata: {
            procedure: "models.deployment.update",
            kind: "deployment_model",
            provider: choice.provider,
          },
        })),
      );
    } finally {
      record.mockRestore();
    }
  });

  it("goes back to the environment's model and removes the key", async () => {
    const { deps, secrets, row } = setup({
      row: {
        deploymentModelProvider: "anthropic",
        deploymentModelId: "claude-sonnet-5",
        deploymentModelCredentialCipher: "sealed-earlier",
      },
    });
    const settings = await updateDeploymentModelSettings(deps, admin, { provider: null });
    expect(row()).toEqual({
      deploymentModelProvider: null,
      deploymentModelId: null,
      deploymentModelCredentialCipher: null,
    });
    expect(secrets.delete).toHaveBeenCalledWith("sealed-earlier", "deployment-model");
    expect(settings).toMatchObject({ provider: null, modelId: null, keySaved: false });
  });
});
