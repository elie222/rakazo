import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "../models/model-secret.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import type { MediaSource, MediaSourceDeps } from "./media-sources.js";
import { mediaVideoProviderForSource, resolveRunMediaSources } from "./media-sources.js";

const scope = { userId: "owner", spaceId: "space" };

type Connection = { id: string; provider: string };

/** `connections` are newest first, as the lookup orders them. */
function deps(
  connections: Connection | Connection[] | null,
  chosen: Array<{ role: string; credentialId: string; modelId: string }> = [],
): MediaSourceDeps {
  const list = connections === null ? [] : [connections].flat();
  return {
    prisma: {
      userModelCredential: {
        findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
          const found = list.find((connection) => !where.id || connection.id === where.id);
          return found ? { ...found, secretId: "secret" } : null;
        }),
        findMany: vi.fn(async () => list.map((connection) => ({ ...connection, label: "Key" }))),
      },
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userModelRoleChoice: {
        findMany: vi.fn(async ({ where }: { where: { role: string } }) =>
          chosen
            .filter((row) => row.role === where.role)
            .map((row) => ({
              ...row,
              position: 0,
              provider: list.find((item) => item.id === row.credentialId)?.provider ?? "openai",
              thinkingLevel: null,
              creditOfferingId: null,
            })),
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
      scope,
    );
    expect(await settle(sources.image)).toEqual({
      record: { kind: "connection", connectionId: "connection", model: "gpt-image-2" },
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
      scope,
    );
    expect(await settle(sources.image)).toMatchObject({ provider: "openai" });
    expect(await settle(sources.video)).toEqual({
      record: { kind: "connection", connectionId: "older", model: "google/veo-3.1-lite" },
      provider: "openrouter",
    });
  });

  it("uses the deployment's provider when the owner has no connection that makes media", async () => {
    const sources = await resolveRunMediaSources(deps(null), scope);
    expect(await settle(sources.image)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
    expect(await settle(sources.video)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
  });

  it("falls back to the deployment when the connection holds no usable key", async () => {
    const broken = deps({ id: "connection", provider: "openai" });
    broken.secretStore.load = async () =>
      serializeModelSecret({ kind: "oauth", reconnectRequired: true });
    const sources = await resolveRunMediaSources(broken, scope);
    expect(await settle(sources.image)).toEqual({ record: { kind: "hosted" }, provider: "fake" });
  });

  it("makes media with the model the owner chose on that connection", async () => {
    const sources = await resolveRunMediaSources(
      deps({ id: "connection", provider: "openrouter" }, [
        { role: "video", credentialId: "connection", modelId: "google/veo-3.1-fast" },
      ]),
      scope,
    );
    expect((await sources.video?.())?.record).toEqual({
      kind: "connection",
      connectionId: "connection",
      model: "google/veo-3.1-fast",
    });
  });

  it("rebuilds a saved job's provider from its connection, and none once it is gone", async () => {
    const source = { kind: "connection" as const, connectionId: "connection" };
    const live = deps({ id: "connection", provider: "openai" });
    expect((await mediaVideoProviderForSource(live, "owner", source))?.id).toBe("openai");
    expect(await mediaVideoProviderForSource(deps(null), "owner", source)).toBeUndefined();
  });
});
