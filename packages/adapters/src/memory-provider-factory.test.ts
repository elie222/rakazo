import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalServiceBaseUrl } from "./local-service-endpoint.js";
import {
  createMemoryProvider,
  isRetryableMemoryError,
  SpaceMemoryProviderResolver,
} from "./memory-provider-factory.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

// The resolver requests all addresses; select that overload for array-valued mock responses.
const lookupAll: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> = lookup;

function resolverFor(
  plaintext: string,
  options: {
    provider?: string;
    mode?: "cloud" | "local";
    allowPrivateEndpoint?: boolean;
    baseUrl?: string;
    settings?: Record<string, string>;
    defaultMemoryScope?: "isolated" | "shared";
    configured?: boolean;
  } = {},
) {
  vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", options.allowPrivateEndpoint ? "true" : "false");
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async () =>
        options.configured === false
          ? null
          : {
              userId: "config-author",
              provider: options.provider ?? "supermemory",
              settings: {
                mode: options.mode ?? "cloud",
                baseUrl: options.baseUrl ?? "https://api.supermemory.ai",
                ...options.settings,
              },
              defaultMemoryScope: options.defaultMemoryScope ?? "shared",
              secret: { id: "secret-1", ciphertext: "encrypted" },
            },
      ),
    },
  };
  const secrets = { load: vi.fn(async () => plaintext) };
  return {
    resolver: new SpaceMemoryProviderResolver(prisma as never, secrets as never),
    secrets,
    prisma,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("SpaceMemoryProviderResolver.resolveTurnMemory", () => {
  const credentials = JSON.stringify({ token: "synthetic-test-token" });
  const options = {
    provider: "memmy",
    baseUrl: "http://127.0.0.1:8080",
    allowPrivateEndpoint: true,
  };

  it("reports unconfigured only when the configuration row is absent", async () => {
    const { resolver, secrets } = resolverFor(credentials, { ...options, configured: false });

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({ kind: "unconfigured" });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it.each(["isolated", "shared"] as const)(
    "loads the lifecycle and its %s default scope",
    async (defaultMemoryScope) => {
      const { resolver, secrets, prisma } = resolverFor(credentials, {
        ...options,
        defaultMemoryScope,
      });

      const result = await resolver.resolveTurnMemory("space-1");

      expect(result).toMatchObject({ kind: "configured", defaultScope: defaultMemoryScope });
      if (result.kind !== "configured") throw new Error("Expected a configured lifecycle");
      expect(typeof result.lifecycle.beforeTurn).toBe("function");
      expect(typeof result.lifecycle.captureTurn).toBe("function");
      expect(prisma.spaceMemoryConfig.findUnique).toHaveBeenCalledExactlyOnceWith({
        where: { spaceId: "space-1" },
        include: { secret: true },
      });
      expect(secrets.load).toHaveBeenCalledExactlyOnceWith("encrypted", "secret-1");
    },
  );

  it("identifies the connection with stable settings order, not its rotating token", async () => {
    const first = resolverFor(credentials, {
      ...options,
      settings: { ownerId: "owner-1", contextBudget: "8000" },
    });
    const reordered = resolverFor(JSON.stringify({ token: "rotated-synthetic-token" }), {
      ...options,
      settings: { contextBudget: "8000", ownerId: "owner-1" },
    });

    const initial = await first.resolver.resolveTurnMemory("space-1");
    const rotated = await reordered.resolver.resolveTurnMemory("space-1");
    if (initial.kind !== "configured" || rotated.kind !== "configured") {
      throw new Error("Expected configured lifecycles");
    }
    expect(initial.captureTarget).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.captureTarget).toBe(initial.captureTarget);
    expect((await first.resolver.resolve("space-1"))?.captureTarget).toBe(initial.captureTarget);
  });

  it.each(["honcho", "supermemory", "serenity"])(
    "keeps legacy %s usable while treating its missing lifecycle as terminal",
    async (provider) => {
      const { resolver, secrets } = resolverFor(
        JSON.stringify({ apiKey: "synthetic-test-key", token: "synthetic-test-token" }),
        { provider, settings: { endpoint: "https://memory.example.com" } },
      );

      await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
        kind: "unavailable",
        reason: "lifecycle_unsupported",
        retryable: false,
      });
      expect(secrets.load).not.toHaveBeenCalled();
      const configured = await resolver.resolve("space-1");
      expect(configured?.provider.describe().id).toBe(provider);
      expect(configured?.lifecycle).toBeUndefined();
      expect(secrets.load).toHaveBeenCalledOnce();
    },
  );

  it("does not resolve or decrypt a private endpoint without operator authorization", async () => {
    const { resolver, secrets } = resolverFor(credentials, {
      ...options,
      allowPrivateEndpoint: false,
    });

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "private_endpoint_not_authorized",
      retryable: false,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it.each(["EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"])(
    "keeps private DNS failure %s retryable and recovers without decrypting on failure",
    async (code) => {
      vi.mocked(lookup).mockRejectedValueOnce(
        Object.assign(new Error("sensitive DNS detail"), { code }),
      );
      vi.mocked(lookupAll).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
      const { resolver, secrets } = resolverFor(credentials, {
        ...options,
        baseUrl: "http://memory.example.com",
      });

      await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
        kind: "unavailable",
        reason: "endpoint_unavailable",
        retryable: true,
      });
      expect(secrets.load).not.toHaveBeenCalled();
      await expect(resolver.resolveTurnMemory("space-1")).resolves.toMatchObject({
        kind: "configured",
      });
      expect(secrets.load).toHaveBeenCalledOnce();
    },
  );

  it("reports malformed persisted URLs as unavailable before decrypting", async () => {
    const { resolver, secrets } = resolverFor(credentials, { ...options, baseUrl: "not a URL" });

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "endpoint_revalidation_failed",
      retryable: false,
    });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("does not expose database or secret-store exceptions", async () => {
    const databaseFailure = resolverFor(credentials, options);
    databaseFailure.prisma.spaceMemoryConfig.findUnique.mockRejectedValueOnce(
      new Error("synthetic-private-database-detail"),
    );
    await expect(databaseFailure.resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "configuration_load_failed",
      retryable: false,
    });

    const secretFailure = resolverFor(credentials, options);
    secretFailure.secrets.load.mockRejectedValueOnce(
      new Error("synthetic-private-credential-detail"),
    );
    await expect(secretFailure.resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "credential_load_failed",
      retryable: false,
    });
  });

  it("treats a private hostname resolving publicly as terminal without decrypting", async () => {
    vi.mocked(lookupAll).mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
    const { resolver, secrets } = resolverFor(credentials, {
      ...options,
      baseUrl: "http://memory.example.com",
    });

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "endpoint_revalidation_failed",
      retryable: false,
    });
    await expect(resolver.resolve("space-1")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("does not retry an unclassified resolver error", async () => {
    const { resolver, secrets } = resolverFor(credentials, {
      ...options,
      baseUrl: "http://memory.example.com",
    });
    vi.mocked(lookup).mockRejectedValueOnce(new Error("Unclassified DNS failure"));

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "endpoint_revalidation_failed",
      retryable: false,
    });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it.each([undefined, 408, 425, 429, 503])(
    "retries an unavailable secret store with status %s and recovers",
    async (status) => {
      const { resolver, secrets } = resolverFor(credentials, options);
      secrets.load.mockRejectedValueOnce(new SecretStoreUnavailableError(status));

      await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
        kind: "unavailable",
        reason: "secret_store_unavailable",
        retryable: true,
      });
      await expect(resolver.resolveTurnMemory("space-1")).resolves.toMatchObject({
        kind: "configured",
      });
    },
  );

  it.each([401, 403, 404])("does not retry secret-store status %s", async (status) => {
    const { resolver, secrets } = resolverFor(credentials, options);
    secrets.load.mockRejectedValueOnce(new SecretStoreUnavailableError(status));

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "secret_store_unavailable",
      retryable: false,
    });
  });

  it.each([new SecretNotFoundError(), new Error("Encrypted secret is malformed")])(
    "does not retry a missing or corrupt credential",
    async (error) => {
      const { resolver, secrets } = resolverFor(credentials, options);
      secrets.load.mockRejectedValueOnce(error);

      await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
        kind: "unavailable",
        reason: "credential_load_failed",
        retryable: false,
      });
    },
  );

  it.each([
    Object.assign(new Error("database connection unavailable"), { code: "P1001" }),
    Object.assign(new Error("database initialization unavailable"), { errorCode: "P1002" }),
    new Error("database unavailable", {
      cause: Object.assign(new Error("transport detail"), { code: "ECONNRESET" }),
    }),
  ])("retries a classified database outage without loading credentials", async (error) => {
    const { resolver, secrets, prisma } = resolverFor(credentials, options);
    prisma.spaceMemoryConfig.findUnique.mockRejectedValueOnce(error);

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason: "configuration_unavailable",
      retryable: true,
    });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid credentials", "not-json", options, "invalid_credentials"],
    ["unknown provider", credentials, { ...options, provider: "unknown" }, "unknown_provider"],
    [
      "invalid provider settings",
      credentials,
      { ...options, settings: { contextBudget: "invalid" } },
      "invalid_provider_configuration",
    ],
    [
      "missing token",
      JSON.stringify({ unrelated: "value" }),
      options,
      "invalid_provider_configuration",
    ],
  ] as const)("reports %s as terminal", async (_label, plaintext, settings, reason) => {
    const { resolver } = resolverFor(plaintext, settings);

    await expect(resolver.resolveTurnMemory("space-1")).resolves.toEqual({
      kind: "unavailable",
      reason,
      retryable: false,
    });
    await expect(resolver.resolve("space-1")).resolves.toBeNull();
  });
});

describe("isRetryableMemoryError", () => {
  it("recognizes wrapped key-manager service outages and keeps invalid ciphertext terminal", () => {
    expect(
      isRetryableMemoryError(
        new Error("Space key could not be unwrapped", {
          cause: Object.assign(new Error("key manager unavailable"), { $fault: "server" }),
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableMemoryError(
        new Error("Space key could not be unwrapped", {
          cause: Object.assign(new Error("invalid ciphertext"), {
            $fault: "client",
            $metadata: { httpStatusCode: 400 },
          }),
        }),
      ),
    ).toBe(false);
    expect(isRetryableMemoryError(new Error("Unknown key"))).toBe(false);
  });

  it("recognizes nested Prisma driver errors and rejects authentication errors", () => {
    expect(
      isRetryableMemoryError({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "57P03" } } },
      }),
    ).toBe(true);
    expect(isRetryableMemoryError({ code: "P1000" })).toBe(false);
    expect(isRetryableMemoryError({ code: "28P01" })).toBe(false);
  });

  it("handles aggregate connection failures and circular causes without treating unknown errors as transient", () => {
    const failure = Object.assign(new Error("connection timeout"), { code: "ETIMEDOUT" });
    expect(isRetryableMemoryError(new AggregateError([failure]))).toBe(true);
    const circular = new Error("unknown failure");
    circular.cause = circular;
    expect(isRetryableMemoryError(circular)).toBe(false);
  });
});

describe("SpaceMemoryProviderResolver", () => {
  it.each(["honcho", "supermemory"])(
    "disables %s without loading credentials when local DNS revalidation fails",
    async (provider) => {
      vi.mocked(lookup).mockRejectedValue(new Error("DNS unavailable"));
      const { resolver, secrets } = resolverFor(JSON.stringify({ apiKey: "fake-key" }), {
        provider,
        mode: "local",
        baseUrl: "http://memory.example.test:8000",
        allowPrivateEndpoint: true,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(lookup).toHaveBeenCalled();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );

  it("gates and revalidates saved local Honcho endpoints like other local providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const local = { provider: "honcho", mode: "local" as const };

    const notOwner = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://127.0.0.1:8000",
      allowPrivateEndpoint: false,
    });
    await expect(notOwner.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(notOwner.secrets.load).not.toHaveBeenCalled();

    const publicHost = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://203.0.113.10:8000",
      allowPrivateEndpoint: true,
    });
    await expect(publicHost.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(publicHost.secrets.load).not.toHaveBeenCalled();

    const missingUrl = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "",
      allowPrivateEndpoint: true,
    });
    await expect(missingUrl.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(missingUrl.secrets.load).not.toHaveBeenCalled();

    const owned = resolverFor(JSON.stringify({ apiKey: "honcho-admin-token" }), {
      ...local,
      baseUrl: "http://127.0.0.1:8000",
      allowPrivateEndpoint: true,
    });
    const configured = await owned.resolver.resolve("workspace-1");
    expect(configured?.provider.describe().id).toBe("honcho");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "disables saved local configurations without explicit operator authorization: %s",
    async (allowPrivateEndpoint) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { resolver, secrets } = resolverFor("sm_fake_key", {
        mode: "local",
        baseUrl: "http://127.0.0.1:8123/internal-action#",
        allowPrivateEndpoint,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(secrets.load).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains deployment-owner-configured local memory for Space members", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://localhost:6767/memory/",
      allowPrivateEndpoint: true,
    });
    const configured = await resolver.resolve("workspace-1");
    await configured!.provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "space-member",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:6767/memory/v4/search");
  });

  it("disables ambiguous persisted URLs even when the deployment owner configured them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://127.0.0.1:8123/internal-action#",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads generic JSON credential payloads", async () => {
    const { resolver } = resolverFor(JSON.stringify({ apiKey: "sm_json_key" }));

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
    expect(configured?.defaultScope).toBe("shared");
  });

  it("keeps legacy raw Supermemory credentials usable after the schema migration", async () => {
    const { resolver } = resolverFor("sm_legacy_key");

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
  });

  it("revalidates persisted provider endpoints before using decrypted credentials", async () => {
    const { resolver, secrets } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://203.0.113.10:6767",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();

    await expect(
      assertLocalServiceBaseUrl("https://memory.example.com", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);
    await expect(
      assertLocalServiceBaseUrl("http://example.com:6767", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);

    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "http://203.0.113.10:6767" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/private-network/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createMemoryProvider(
      "supermemory",
      { mode: "cloud", baseUrl: "https://memory.example.com" },
      { apiKey: "sm_test_key" },
    );

    await provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
