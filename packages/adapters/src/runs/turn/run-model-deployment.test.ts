import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveConnectedModelKey, resolveModelKey } from "./run-model.js";

const scope = { userId: "member-example", spaceId: "space-example" };
const saved = {
  deploymentModelProvider: "anthropic",
  deploymentModelId: "claude-sonnet-5",
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
      userModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
    },
    secretStore: { load },
  } as unknown as ExecutorDeps;
  return { deps, load };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the model an admin set for everyone", () => {
  it("runs on the admin's key and redacts it", async () => {
    const { deps } = setup(false);
    vi.mocked(deps.prisma.deploymentSettings.findUnique).mockResolvedValue(null);
    const registerSecrets = vi.fn();
    const resolved = await resolveModelKey(
      deps,
      scope.userId,
      scope.spaceId,
      null,
      "anthropic",
      "claude-sonnet-5",
      registerSecrets,
      { adminSettings: saved },
    );
    expect(resolved.apiKey).toBe("fake-admin-key");
    expect(resolved.redact).toContain("fake-admin-key");
    expect(registerSecrets).toHaveBeenCalledWith(["fake-admin-key"]);
    expect(resolved.billing).toBe("deployment");
  });

  it("restores the current shared model without a personal connection", async () => {
    const { deps, load } = setup(false);
    const result = await resolveConnectedModelKey(
      deps,
      scope,
      "anthropic",
      "claude-sonnet-5",
      undefined,
      true,
    );
    expect(result.credential).toBeNull();
    expect(result.resolved.apiKey).toBe("fake-admin-key");
    expect(load).toHaveBeenCalledOnce();
  });

  it("serves only the model it was saved for", async () => {
    const { deps, load } = setup(false);
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        "anthropic",
        "claude-opus-5",
        undefined,
        { adminSettings: saved },
      ),
    ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
    expect(load).not.toHaveBeenCalled();
  });

  it("is never used for the operator's own checker", async () => {
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
      ),
    ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
    expect(load).not.toHaveBeenCalled();
  });

  it("is never used for a call on model credits", async () => {
    const { deps, load } = setup(true);
    await expect(
      resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        "anthropic",
        "claude-sonnet-5",
        undefined,
        { adminSettings: saved },
      ),
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
        { operatorFunded: true, adminSettings: saved },
      ),
    ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("an operator's workload identity", () => {
  it("authorizes the configured deployment model and registers the bearer for redaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deployment-identity-"));
    try {
      const tokenFile = join(dir, "token");
      await writeFile(tokenFile, "test-assertion", { mode: 0o600 });
      vi.stubEnv("PI_DEFAULT_PROVIDER", "openai");
      vi.stubEnv("PI_DEFAULT_MODEL", "gpt-6-luna");
      vi.stubEnv("PI_DEFAULT_CREDENTIALS", "host");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENAI_IDENTITY_TOKEN_FILE", tokenFile);
      vi.stubEnv("OPENAI_IDENTITY_PROVIDER_ID", "fixture-provider");
      vi.stubEnv("OPENAI_SERVICE_ACCOUNT_ID", "fixture-account");
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ access_token: "fixture-runtime-bearer", expires_in: 600 }),
        );
      vi.stubGlobal("fetch", fetcher);
      const { deps, load } = setup(false);
      const registerSecrets = vi.fn();
      const resolved = await resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        "openai",
        "gpt-6-luna",
        registerSecrets,
      );
      expect(resolved).toMatchObject({ apiKey: "fixture-runtime-bearer", billing: "deployment" });
      expect(registerSecrets).toHaveBeenCalledWith(["fixture-runtime-bearer"]);
      expect(load).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
