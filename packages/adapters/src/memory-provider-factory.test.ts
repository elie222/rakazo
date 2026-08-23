import { describe, expect, it, vi } from "vitest";
import { WorkspaceMemoryProviderResolver } from "./memory-provider-factory.js";

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
});
