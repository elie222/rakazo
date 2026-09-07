import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
function fixture() {
  const rows = new Map<string, { id: string; ciphertext: string }>();
  const prisma = {
    integrationProviderConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
        rows.set(create.id, create);
        return create;
      }),
    },
  };
  const adapter = {
    listConnectedExternalIds: vi.fn(async () => []),
    catalog: vi.fn(async () => []),
    discoverTools: vi.fn(async () => []),
  } as unknown as ManagedConnectorProvider;
  const factory = vi.fn(() => adapter);
  const secrets = new EncryptedSecretStore("test-encryption-key");
  const settings = new IntegrationProviderSettings(
    prisma as unknown as PrismaClient,
    secrets,
    "test-identity",
    {},
    factory,
  );
  return { rows, prisma, adapter, factory, secrets, settings };
}
describe("integration provider settings", () => {
  it("encrypts credentials and shares updates with a separately created worker resolver", async () => {
    const f = fixture();
    const worker = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {},
      f.factory,
    );
    expect(await worker.resolve("composio")).toBeUndefined();
    await f.settings.save({ provider: "composio", apiKey: "fake-first-key" }, context);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("fake-first-key");
    expect(await worker.resolve("composio")).toBe(f.adapter);
    expect(f.factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-first-key" });
    await f.settings.save({ provider: "composio", apiKey: "fake-replacement-key" }, context);
    await worker.resolve("composio");
    expect(f.factory).toHaveBeenLastCalledWith({
      provider: "composio",
      apiKey: "fake-replacement-key",
    });
  });
  it("preserves working settings and hides provider error details on failed verification", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
    const before = f.rows.get("composio");
    vi.mocked(f.adapter.listConnectedExternalIds).mockRejectedValueOnce(
      new Error("fake-secret-in-provider-response"),
    );
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-bad-key" }, context),
    ).rejects.toThrow("Could not verify these credentials");
    expect(f.rows.get("composio")).toBe(before);
  });
  it("returns no tools or catalog for unconfigured providers", async () => {
    const f = fixture();
    for (const provider of f.settings.providers()) {
      expect(await provider.catalog(context)).toEqual([]);
      expect(await provider.discoverTools(context)).toEqual([]);
      await expect(
        provider.begin({ provider: "slack", redirectUrl: "https://example.test" }, context),
      ).rejects.toThrow("Set up an integration provider");
    }
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("warms directories only for configured providers", async () => {
    const f = fixture();
    const warm = vi.fn(async () => undefined);
    const adapter = {
      listConnectedExternalIds: vi.fn(async () => []),
      catalog: vi.fn(async () => []),
      discoverTools: vi.fn(async () => []),
      warmDirectory: warm,
    } as unknown as ManagedConnectorProvider;
    f.factory.mockReturnValue(adapter);
    const fallbackWarm = vi.fn(async () => undefined);
    const settings = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {
        pipedream: {
          warmDirectory: fallbackWarm,
        } as unknown as ManagedConnectorProvider,
      },
      f.factory,
    );
    settings.warmDirectories();
    await vi.waitFor(() => expect(fallbackWarm).toHaveBeenCalledOnce());
    expect(warm).not.toHaveBeenCalled();
    await settings.save({ provider: "composio", apiKey: "fake-warm-key" }, context);
    settings.warmDirectories();
    await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce());
  });
});
