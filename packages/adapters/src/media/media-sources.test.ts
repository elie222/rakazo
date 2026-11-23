import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "../models/model-secret.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import type { MediaSourceDeps } from "./media-sources.js";
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

describe("run media sources", () => {
  it("makes images with the owner's connection and leaves video it cannot make to the deployment", async () => {
    const sources = await resolveRunMediaSources(
      deps({ id: "connection", provider: "openai" }),
      "owner",
    );
    expect(sources.image?.record).toEqual({ kind: "connection", connectionId: "connection" });
    expect((await sources.image?.provider())?.id).toBe("openai");
    expect(sources.video?.record).toEqual({ kind: "hosted" });
    expect((await sources.video?.provider())?.id).toBe("fake");
  });

  it("uses the deployment's provider when the owner has no connection that makes media", async () => {
    const sources = await resolveRunMediaSources(deps(null), "owner");
    expect(sources.image?.record).toEqual({ kind: "hosted" });
    expect(sources.video?.record).toEqual({ kind: "hosted" });
  });

  it("rebuilds a saved job's provider from its connection, and none once it is gone", async () => {
    const source = { kind: "connection" as const, connectionId: "connection" };
    const live = deps({ id: "connection", provider: "openai" });
    expect((await mediaProviderForSource(live, "owner", source))?.id).toBe("openai");
    expect(await mediaProviderForSource(deps(null), "owner", source)).toBeUndefined();
  });
});
