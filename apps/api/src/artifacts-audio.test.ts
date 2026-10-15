import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createOwnedArtifact } from "./artifacts.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
function audioBytes() {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}
function fixture() {
  const artifact = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation(async ({ data }) => ({
      ...data,
      id: "artifact-1",
      createdAt: new Date(0),
    })),
  };
  const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([]) };
  const put = vi.fn().mockResolvedValue({ id: "stored-1", hash: "46" });
  const remove = vi.fn().mockResolvedValue(undefined);
  const deps = {
    prisma: {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient,
    artifacts: { put, remove } as unknown as ArtifactStore,
  };
  return { artifact, put, remove, deps };
}

describe("original audio attachment upload", () => {
  it("stores original validated bytes under the authenticated owner with no transcript substitution", async () => {
    const { deps, artifact, put } = fixture();
    const bytes = audioBytes();
    const result = await createOwnedArtifact(deps, actor, {
      botId: "bot-1",
      name: "voice.wav",
      mimeType: "audio/x-wav",
      contentBase64: bytes.toString("base64"),
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(put).toHaveBeenCalledWith(
      { name: "voice.wav", mimeType: "audio/wav", bytes: new Uint8Array(bytes) },
      expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
    );
    expect(artifact.create.mock.calls[0]![0].data).toMatchObject({
      spaceId: actor.spaceId,
      userId: actor.userId,
      mimeType: "audio/wav",
      size: bytes.length,
    });
  });

  it.each(["AAAA", "AB==", Buffer.from("https://example.test/audio.wav").toString("base64")])(
    "rejects malformed or mislabeled audio before storage",
    async (contentBase64) => {
      const { deps, put, artifact } = fixture();
      await expect(
        createOwnedArtifact(deps, actor, {
          botId: "bot-1",
          name: "voice.wav",
          mimeType: "audio/wav",
          contentBase64,
        }),
      ).rejects.toThrow();
      expect(put).not.toHaveBeenCalled();
      expect(artifact.create).not.toHaveBeenCalled();
    },
  );

  it("cleans up stored audio if persistence fails", async () => {
    const { deps, artifact, remove } = fixture();
    artifact.create.mockRejectedValue(new Error("database unavailable"));
    await expect(
      createOwnedArtifact(deps, actor, {
        botId: "bot-1",
        name: "voice.wav",
        mimeType: "audio/wav",
        contentBase64: audioBytes().toString("base64"),
      }),
    ).rejects.toThrow("database unavailable");
    expect(remove).toHaveBeenCalledWith(
      "stored-1",
      expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
    );
  });
});
