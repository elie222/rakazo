import { describe, expect, it, vi } from "vitest";
import {
  createMemoryProvider,
  WorkspaceMemoryProviderResolver,
} from "./memory-provider-factory.js";

function resolverFor(plaintext: string) {
  const prisma = {
    workspaceMemoryConfig: {
      findUnique: vi.fn(async () => ({
        provider: "supermemory",
        settings: { mode: "cloud", baseUrl: "https://api.supermemory.ai" },
        defaultMemoryScope: "shared",
        secret: { ciphertext: "encrypted" },
      })),
    },
  };
  const secrets = { load: vi.fn(() => plaintext) };
  return {
    resolver: new WorkspaceMemoryProviderResolver(prisma as never, secrets as never),
    secrets,
  };
}

describe("WorkspaceMemoryProviderResolver", () => {
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
    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "https://memory.example.com" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/loopback/);

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
        workspaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
    vi.unstubAllGlobals();
  });
});
