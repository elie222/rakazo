import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveModelKey } from "./run-model.js";

const scope = { userId: "member-example", spaceId: "space-example" };
const saved = {
  defaultModelProvider: "anthropic",
  defaultModelId: "claude-sonnet-5",
  deploymentModelCredentialCipher: "sealed-admin-key",
  modelCreditsEnabled: false,
};

function setup(billingEnabled: boolean) {
  const load = vi.fn(async () => JSON.stringify({ kind: "api_key", key: "fake-admin-key" }));
  const deps = {
    billingEnabled,
    prisma: {
      deploymentSettings: { findUnique: vi.fn(async () => saved) },
      space: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
    },
    secretStore: { load },
  } as unknown as ExecutorDeps;
  return { deps, load };
}

afterEach(() => vi.unstubAllEnvs());

describe("the model an admin set for everyone", () => {
  it("runs on the admin's key and redacts it", async () => {
    const { deps } = setup(false);
    const registerSecrets = vi.fn();
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      null,
      "anthropic",
      "claude-sonnet-5",
      registerSecrets,
    );
    expect(resolved.apiKey).toBe("fake-admin-key");
    expect(resolved.redact).toContain("fake-admin-key");
    expect(registerSecrets).toHaveBeenCalledWith(["fake-admin-key"]);
    expect(resolved.billing).toBe("deployment");
  });

  it("is never used for a call on model credits", async () => {
    const { deps, load } = setup(true);
    await expect(
      resolveModelKey(deps, scope.userId, scope.spaceId, null, "anthropic", "claude-sonnet-5"),
    ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
    expect(load).not.toHaveBeenCalled();
  });

  it("is never used for a call the operator pays for", async () => {
    const { deps, load } = setup(false);
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        "anthropic",
        "claude-sonnet-5",
        undefined,
        { operatorFunded: true },
      ),
    ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
    expect(load).not.toHaveBeenCalled();
  });
});
