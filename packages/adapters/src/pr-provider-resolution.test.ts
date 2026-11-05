import { lookup } from "node:dns/promises";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

function resolver(baseUrl = "https://memory.example.test", provider = "memmy") {
  const secrets = { load: vi.fn(async () => JSON.stringify({ token: "fixture-service-token" })) };
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async () => ({
        provider,
        settings: { baseUrl, endpointTrust: "private", mode: "cloud" },
        defaultMemoryScope: "isolated",
        secret: { id: "fixture-secret", ciphertext: "encrypted" },
      })),
    },
  };
  return { value: new SpaceMemoryProviderResolver(prisma as never, secrets as never), secrets };
}

describe("PR provider-resolution regressions", () => {
  it("preserves legacy provider credential-load error propagation", async () => {
    const { value, secrets } = resolver("https://api.supermemory.ai", "supermemory");
    secrets.load.mockRejectedValueOnce(new Error("synthetic secret backend failure"));
    await expect(value.resolve("space-legacy")).rejects.toThrow("synthetic secret backend failure");
  });
  it("bounds private DNS revalidation before decrypting credentials", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "true");
    vi.mocked(lookup).mockImplementation(() => new Promise(() => undefined));
    const { value, secrets } = resolver();
    let settled = false;
    let result: unknown;
    const pending = value.resolveTurnMemory("space-slow").then((outcome) => {
      settled = true;
      result = outcome;
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled).toBe(true);
    await pending;
    expect(result).toEqual({
      kind: "unavailable",
      reason: "endpoint_unavailable",
      retryable: true,
    });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("identifies the affected space without logging credentials", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", "false");
    const { value } = resolver("http://127.0.0.1:8080");
    await expect(value.resolve("space-disabled")).resolves.toBeNull();
    const serialized = JSON.stringify(sink.events);
    expect(serialized).toContain("space-disabled");
    expect(serialized).not.toContain("fixture-service-token");
  });
});
