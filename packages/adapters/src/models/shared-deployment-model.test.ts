import { SecretStoreUnavailableError, SharedModelCredentialUnavailable } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeWorkloadIdentity } from "../providers/model/openai/workload-identity.js";
import { verifyModelServesAgents } from "./model-connect-check.js";
import { selectConfiguredModel } from "./model-roles.js";
import {
  bindDeploymentModelCredential,
  readSharedDeploymentModel,
  sharedModelProviders,
  sharedModelRequestCredential,
  testSharedModel,
} from "./shared-deployment-model.js";

vi.mock("../providers/model/openai/workload-identity.js", () => ({
  exchangeWorkloadIdentity: vi.fn(),
}));
vi.mock("./model-connect-check.js", () => ({ verifyModelServesAgents: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

const current = {
  provider: "test-provider",
  modelId: "test-model",
  method: "api_key" as const,
  revision: "current-revision",
  credentialCipher: "sealed-key",
};

function oauthModel(revision: string) {
  vi.stubEnv(
    "RAKAZO_MODEL_OAUTH_BINDINGS",
    JSON.stringify({ fixture: { provider: "openai", config: {} } }),
  );
  const row = {
    ...current,
    provider: "openai",
    method: "oauth" as const,
    revision: revision,
  };
  const findUnique = vi.fn().mockResolvedValue(row);
  const prisma = { deploymentModelConnection: { findUnique } } as unknown as Pick<
    PrismaClient,
    "deploymentModelConnection"
  >;
  const load = vi.fn(async () => "fixture");
  const read = (signal?: AbortSignal) =>
    sharedModelRequestCredential(prisma, { load }, row, signal);
  const { deploymentCredential } = bindDeploymentModelCredential(prisma, { load }, row);
  return { read, findUnique, row, load, deploymentCredential };
}

describe("the deployment default", () => {
  it("fills the fallback slot while personal selections keep their precedence", async () => {
    const findUnique = vi.fn().mockResolvedValue(current);
    const prisma = { deploymentModelConnection: { findUnique } } as unknown as Pick<
      PrismaClient,
      "deploymentModelConnection"
    >;
    const shared = await readSharedDeploymentModel(prisma);
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
    findUnique.mockResolvedValue({ ...current, disabled: true });
    const disabled = await readSharedDeploymentModel(prisma);
    expect(
      selectConfiguredModel({
        ...run,
        defaults: {
          ...defaults,
          shared: disabled,
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

  it("evicts only the rejected token for the cached connection revision", async () => {
    const old = oauthModel("old-rejection-revision");
    const current = oauthModel("current-rejection-revision");
    const sharedKey = "fixture-rejected-token";
    const freshKey = "fixture-replacement-token";
    const expiresAt = Date.now() + 60_000;
    const exchange = vi
      .mocked(exchangeWorkloadIdentity)
      .mockResolvedValueOnce({ key: sharedKey, expiresAt })
      .mockResolvedValueOnce({ key: sharedKey, expiresAt })
      .mockResolvedValueOnce({ key: freshKey, expiresAt });

    await expect(old.read()).resolves.toBe(sharedKey);
    await expect(current.read()).resolves.toBe(sharedKey);
    old.deploymentCredential.invalidate!(sharedKey);
    await expect(current.read()).resolves.toBe(sharedKey);
    expect(exchange).toHaveBeenCalledTimes(2);

    current.deploymentCredential.invalidate!(sharedKey);
    await expect(current.read()).resolves.toBe(freshKey);
    current.deploymentCredential.invalidate!(sharedKey);
    await expect(current.read()).resolves.toBe(freshKey);
    expect(exchange).toHaveBeenCalledTimes(3);
  });

  it("shares a failed OAuth exchange across concurrent callers and permits a later retry", async () => {
    const { read, load } = oauthModel("shared-failure");
    const pending = deferred<{ key: string; expiresAt: number }>();
    const exchange = vi.mocked(exchangeWorkloadIdentity).mockReturnValueOnce(pending.promise);
    const first = read();
    const second = read();
    const outcome = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await flush();
    pending.reject(new ClientError("SERVICE_UNAVAILABLE", "upstream unavailable"));
    for (const result of await outcome) {
      expect(result).toEqual({
        status: "rejected",
        reason: expect.any(SharedModelCredentialUnavailable),
      });
    }
    expect(exchange).toHaveBeenCalledTimes(1);
    exchange.mockResolvedValueOnce({ key: "new-bearer", expiresAt: Date.now() + 60_000 });
    await expect(read()).resolves.toBe("new-bearer");
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("lets one caller cancel without interrupting another caller's exchange", async () => {
    const { read, load } = oauthModel("shared-cancellation");
    const controller = new AbortController();
    const pending = deferred<{ key: string; expiresAt: number }>();
    const exchange = vi.mocked(exchangeWorkloadIdentity).mockReturnValueOnce(pending.promise);
    const first = expect(read(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const second = read();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await flush();
    controller.abort();
    await first;
    expect(exchange.mock.lastCall?.[1].aborted).toBe(false);
    pending.resolve({ key: "shared-bearer", expiresAt: Date.now() + 60_000 });
    await expect(second).resolves.toBe("shared-bearer");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("reports recoverable unseal failures only while the connection is still active", async () => {
    const { findUnique, load, read, row } = oauthModel("unseal-failure");
    const unreadable = new SecretStoreUnavailableError(undefined, "internal diagnostic");
    load.mockRejectedValueOnce(unreadable).mockRejectedValueOnce(unreadable);
    await expect(read()).rejects.toEqual(
      new SharedModelCredentialUnavailable("The deployment model credential could not be read."),
    );
    findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, disabled: true });
    await expect(read()).rejects.toThrow("deployment model connection changed");
  });

  it("keeps a revoked connection from falling back when its exchange fails", async () => {
    const { findUnique, read, row } = oauthModel("revoked-failure");
    findUnique.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, revision: "new" });
    vi.mocked(exchangeWorkloadIdentity).mockRejectedValueOnce(
      new ClientError("SERVICE_UNAVAILABLE", "upstream unavailable"),
    );
    await expect(read()).rejects.toThrow("deployment model connection changed");
  });

  it("reports an unexpected verification defect without leaking its credential", async () => {
    const bug = new TypeError("fixture defect echoing fixture-key");
    vi.mocked(verifyModelServesAgents).mockRejectedValueOnce(bug);
    const error = await testSharedModel({
      provider: "openai",
      modelId: "fixture",
      method: "api_key",
      apiKey: "fixture-key",
    }).catch((error: unknown) => error);
    expect(error).toStrictEqual(new Error("Unexpected deployment model verification failure."));
    expect(error).not.toHaveProperty("cause");
  });

  it("checks the connection revision again after the key has loaded", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({
        ...current,
        revision: "new-revision",
      });
    const prisma = { deploymentModelConnection: { findUnique } } as unknown as Pick<
      PrismaClient,
      "deploymentModelConnection"
    >;
    const load = vi.fn(async () => "fixture-key");
    await expect(sharedModelRequestCredential(prisma, { load }, current)).rejects.toThrow(
      "deployment model connection changed",
    );
  });
});
