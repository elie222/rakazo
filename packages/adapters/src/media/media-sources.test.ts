import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "../models/model-secret.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import type { MediaSource, MediaSourceDeps } from "./media-sources.js";
import { mediaProviderForSource, resolveRunMediaSources } from "./media-sources.js";

type Connection = { id: string; provider: string };

/** `connections` are newest first, as the lookup orders them. */
function deps(connections: Connection | Connection[] | null): MediaSourceDeps {
  const list = connections === null ? [] : [connections].flat();
  return {
    prisma: {
      userModelCredential: {
        findFirst: vi.fn(
          async ({ where }: { where: { id?: string; provider?: { in: string[] } } }) => {
            const found = list.find(
              (connection) =>
                (!where.id || connection.id === where.id) &&
                (!where.provider || where.provider.in.includes(connection.provider)),
            );
            return found ? { ...found, secretId: "secret" } : null;
          },
        ),
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

  it("uses an older connection for video when the newest one makes only images", async () => {
    const sources = await resolveRunMediaSources(
      deps([
        { id: "newer", provider: "openai" },
        { id: "older", provider: "openrouter" },
      ]),
      "owner",
    );
    expect(await settle(sources.image)).toMatchObject({ provider: "openai" });
    expect(await settle(sources.video)).toEqual({
      record: { kind: "connection", connectionId: "older" },
      provider: "openrouter",
    });
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
