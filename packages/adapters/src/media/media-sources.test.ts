import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "../models/model-secret.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import type { MediaSource, MediaSourceDeps } from "./media-sources.js";
import { mediaProviderForSource, resolveRunMediaSources } from "./media-sources.js";

function deps(connection: { id: string; provider: string } | null): MediaSourceDeps {
  return {
    prisma: {
      userModelCredential: {
        findFirst: vi.fn().mockResolvedValue(connection && { ...connection, secretId: "secret" }),
      },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret", ciphertext: "sealed" }) },
    } as unknown as MediaSourceDeps["prisma"],
    secretStore: {
      load: vi.fn(async () => serializeModelSecret({ kind: "api_key", key: "fake-key" })),
    },
    mediaGeneration: new FakeMediaGenerationProvider(),
  };
}

const settle = async (source: MediaSource | undefined) => {
  const resolved = await source?.();
  return resolved && { record: resolved.record, provider: resolved.provider.id };
};

describe("run media sources", () => {
  it("makes images with the owner's connection and leaves video it cannot make to the deployment", async () => {
    const sources = await resolveRunMediaSources(
      deps({ id: "connection", provider: "openai" }),
      "owner",
    );
    expect(await settle(sources.image)).toEqual({
      record: { kind: "connection", connectionId: "connection" },
      provider: "openai",
    });
    expect(await settle(sources.video)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
  });

  it("uses the deployment's provider when the owner has no connection that makes media", async () => {
    const sources = await resolveRunMediaSources(deps(null), "owner");
    expect(await settle(sources.image)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
    expect(await settle(sources.video)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
  });

  it("falls back to the deployment when the connection holds no usable key", async () => {
    const broken = deps({ id: "connection", provider: "openai" });
    broken.secretStore.load = async () =>
      serializeModelSecret({ kind: "oauth", reconnectRequired: true });
    const sources = await resolveRunMediaSources(broken, "owner");
    expect(await settle(sources.image)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
  });

  it("rebuilds a saved job's provider from its connection, and none once it is gone", async () => {
    const source = { kind: "connection" as const, connectionId: "connection" };
    const live = deps({ id: "connection", provider: "openai" });
    expect((await mediaProviderForSource(live, "owner", source))?.id).toBe("openai");
    expect(await mediaProviderForSource(deps(null), "owner", source)).toBeUndefined();
  });
});
