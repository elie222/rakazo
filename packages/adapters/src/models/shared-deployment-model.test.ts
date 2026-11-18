import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { selectConfiguredModel } from "./model-roles.js";
import {
  sharedDeploymentModel,
  sharedModelProviders,
  sharedModelRequestCredential,
} from "./shared-deployment-model.js";

const current = {
  sharedModelProvider: "test-provider",
  sharedModelId: "test-model",
  sharedModelMethod: "api_key",
  sharedModelRevision: "current-revision",
  sharedModelCipher: "sealed-key",
};

describe("the deployment default", () => {
  it("fills the fallback slot while personal selections keep their precedence", () => {
    const shared = sharedDeploymentModel(current);
    const defaults = { shared, deployment: { provider: "env-provider", model: "env-model" } };
    const run = { override: null, overrideCredential: null, main: null, defaults };
    expect(selectConfiguredModel(run)).toMatchObject({
      provider: "test-provider",
      id: "test-model",
      deploymentConnection: shared,
    });
    expect(
      selectConfiguredModel({
        ...run,
        main: {
          provider: "personal-provider",
          modelId: "personal-model",
          credentialId: "personal",
          credential: null,
        },
      }),
    ).toMatchObject({ provider: "personal-provider", id: "personal-model" });
    expect(
      selectConfiguredModel({
        ...run,
        defaults: {
          ...defaults,
          shared: sharedDeploymentModel({ ...current, sharedModelDisabled: true }),
        },
      }),
    ).toMatchObject({
      provider: "env-provider",
      id: "env-model",
    });
  });

  it("offers API-key setup when the optional OAuth configuration is invalid", () => {
    vi.stubEnv("RAKAZO_MODEL_OAUTH_BINDINGS", "{");
    try {
      expect(sharedModelProviders()).toContainEqual({
        id: "openai",
        methods: ["api_key"],
        bindings: [],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("checks the connection revision again after the key has loaded", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({
        ...current,
        sharedModelRevision: "new-revision",
      });
    const prisma = { deploymentSettings: { findUnique } } as unknown as Pick<
      PrismaClient,
      "deploymentSettings"
    >;
    const load = vi.fn(async () => "fixture-key");
    await expect(
      sharedModelRequestCredential(prisma, { load }, sharedDeploymentModel(current)!),
    ).rejects.toThrow("deployment model connection changed");
  });
});
