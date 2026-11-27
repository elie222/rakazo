import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamingRedactor, MISSING_MODEL_RUN_ERROR } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveConnectedModelKey, resolvedModelRunFields, resolveModelKey } from "./run-model.js";
import { runModelBackups, startRunModel } from "./run-model-start.js";

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
  vi.restoreAllMocks();
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

async function withHostIdentity(run: () => Promise<void>) {
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
    await run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function startHostRun(deps: ExecutorDeps) {
  const registerSecrets = vi.fn();
  const backups = runModelBackups(
    deps,
    { ...scope, id: "fake-run", modelPinned: false },
    { settings: null, deployment: { provider: "openai", model: "gpt-6-luna" } },
    true,
    registerSecrets,
  );
  return startRunModel(
    deps,
    scope,
    { provider: "openai", id: "gpt-6-luna", credential: null, thinkingLevel: null },
    undefined,
    backups,
    registerSecrets,
  );
}

describe("an operator's workload identity", () => {
  it("redacts old and renewed credentials from progress throughout a run", async () => {
    await withHostIdentity(async () => {
      const now = vi.spyOn(Date, "now");
      const initialTime = Date.now();
      now.mockReturnValue(initialTime);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ access_token: "fixture-runtime-bearer", expires_in: 31 }),
        )
        .mockResolvedValueOnce(
          Response.json({ access_token: "fixture-rotated-bearer", expires_in: 600 }),
        );
      vi.stubGlobal("fetch", fetcher);
      const { deps, load } = setup(false);
      const secrets: string[] = [];
      const registerSecrets = vi.fn((values: string[]) => secrets.push(...values));
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
      const redactor = createStreamingRedactor(secrets);
      const initialProgress = redactor.push("Before fixture-runtime-");
      now.mockReturnValue(initialTime + 32_000);
      const { resolveApiKey } = resolvedModelRunFields(resolved);
      expect(resolveApiKey).toBeTypeOf("function");
      expect(await resolveApiKey?.()).toBe("fixture-rotated-bearer");
      const progress = [
        initialProgress,
        redactor.push("bearer then fixture-ro"),
        redactor.push("tated-bearer."),
        redactor.finish(),
      ].join("");
      expect(progress).toBe("Before [redacted] then [redacted].");
      expect(registerSecrets.mock.calls).toEqual([
        [["fixture-runtime-bearer"]],
        [["fixture-rotated-bearer"]],
      ]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a different keyless model without exchanging the host assertion", async () => {
    await withHostIdentity(async () => {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const { deps } = setup(false);
      await expect(
        resolveModelKey(deps, scope.userId, scope.spaceId, null, "openai", "gpt-other"),
      ).rejects.toThrow(MISSING_MODEL_RUN_ERROR);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it.each([429, 503, 401] as const)(
    "classifies exchange HTTP %s during run setup",
    async (status) => {
      await withHostIdentity(async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
        );
        const { deps } = setup(false);
        if (status === 401) {
          await expect(startHostRun(deps)).resolves.toMatchObject({
            failure: { message: "The deployment model workload identity is unavailable." },
          });
        } else {
          await expect(startHostRun(deps)).rejects.toMatchObject({ kind: "SERVICE_UNAVAILABLE" });
        }
      });
    },
  );

  it("does not replace the admin key with host identity for the same model", async () => {
    await withHostIdentity(async () => {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetcher);
      const { deps } = setup(false);
      vi.mocked(deps.prisma.deploymentSettings.findUnique).mockResolvedValue(null);
      const resolved = await resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        null,
        "openai",
        "gpt-6-luna",
        undefined,
        {
          adminSettings: {
            ...saved,
            deploymentModelProvider: "openai",
            deploymentModelId: "gpt-6-luna",
          },
        },
      );
      expect(resolved.apiKey).toBe("fake-admin-key");
      expect(resolvedModelRunFields(resolved).resolveApiKey).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it("does not treat the exchange deadline as a terminal auth refusal", async () => {
    await withHostIdentity(async () => {
      const reason = new DOMException("The exchange timed out.", "TimeoutError");
      const abort = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(abort.signal);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        abort.abort(reason);
        return Response.json({ access_token: "too-late", expires_in: 600 });
      });
      vi.stubGlobal("fetch", fetcher);
      const { deps } = setup(false);
      await expect(startHostRun(deps)).rejects.toBe(reason);
    });
  });
});
