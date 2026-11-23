import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { updateVoiceSpeechModel } from "./voice.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateVoiceSpeechModel", () => {
  function speechDeps(
    preference: { voiceId: string; isDefault: boolean } | null,
    { overridden = false, provider = "fish-audio" } = {},
  ) {
    const credential = {
      id: "cred-1",
      userId: actor.userId,
      provider,
      secretId: "secret-1",
    };
    const table = () => ({
      findUnique: vi.fn().mockResolvedValue(preference),
      updateMany: vi.fn(),
      upsert: vi
        .fn()
        .mockImplementation(async ({ update }: { update: { speechModel: string | null } }) => ({
          voiceId: preference?.voiceId ?? "",
          isDefault: preference?.isDefault ?? false,
          speechModel: update.speechModel,
        })),
    });
    const prisma = {
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(credential) },
      spaceSettingOverride: {
        findUnique: vi.fn().mockResolvedValue(overridden ? { setting: "voice" } : null),
      },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "sealed" }) },
      userVoicePreference: table(),
      spaceVoicePreference: table(),
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
    return {
      deps: {
        prisma,
        secrets: { put: vi.fn(), load: vi.fn().mockResolvedValue("or-key-12345") },
      } as unknown as VoiceDeps,
      account: prisma.userVoicePreference,
      space: prisma.spaceVoicePreference,
    };
  }

  it("stores the override without changing the selected voice", async () => {
    const { deps, account, space } = speechDeps({ voiceId: "voice-1", isDefault: false });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " s1 " }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "voice-1",
      speechModel: "s1",
      isDefault: false,
    });
    expect(account.upsert).toHaveBeenCalledWith({
      where: { userId_credentialId: { userId: actor.userId, credentialId: "cred-1" } },
      create: { userId: actor.userId, credentialId: "cred-1", speechModel: "s1" },
      update: { speechModel: "s1" },
    });
    expect(account.updateMany).not.toHaveBeenCalled();
    expect(space.upsert).not.toHaveBeenCalled();
  });

  it("stores an ElevenLabs speech model", async () => {
    const { deps, account } = speechDeps(
      { voiceId: "rachel", isDefault: true },
      { provider: "elevenlabs" },
    );

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "elevenlabs", speechModel: "eleven_v4" }),
    ).resolves.toMatchObject({
      provider: "elevenlabs",
      voiceId: "rachel",
      speechModel: "eleven_v4",
    });
    expect(account.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { speechModel: "eleven_v4" } }),
    );
  });

  it("clears the override when the model is blank", async () => {
    const { deps, account } = speechDeps({ voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " " }),
    ).resolves.toMatchObject({ speechModel: "" });
    expect(account.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { speechModel: null } }),
    );
  });

  it("stores a model before a voice is chosen without replacing the default", async () => {
    const { deps, account } = speechDeps(null);

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "",
      speechModel: "s1",
      isDefault: false,
    });
    expect(account.upsert).toHaveBeenCalledOnce();
    expect(account.updateMany).not.toHaveBeenCalled();
  });

  it("writes the Space's own copy in a Space that overrides voice", async () => {
    const { deps, account, space } = speechDeps(
      { voiceId: "voice-1", isDefault: true },
      { overridden: true },
    );

    await updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" });

    expect(space.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-1",
          },
        },
        update: { speechModel: "s1" },
      }),
    );
    expect(account.upsert).not.toHaveBeenCalled();
  });

  it("rejects speech models for other providers before writing", async () => {
    const { deps, account } = speechDeps({ voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "openai", speechModel: "s1" }),
    ).rejects.toThrow("This voice provider has no speech model.");
    expect(account.upsert).not.toHaveBeenCalled();
  });

  describe("for a provider whose models have their own voices", () => {
    function modelVoices(...ids: string[]) {
      const listVoices = vi.fn().mockResolvedValue(ids.map((id) => ({ id, label: id })));
      vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ listVoices } as never);
      vi.spyOn(db, "findVoiceCredential").mockResolvedValue({
        id: "cred-1",
        provider: "openrouter",
        secretId: "secret-1",
      } as never);
      return listVoices;
    }

    it("moves to the first voice of the new model when the current one is not listed", async () => {
      const { deps, account } = speechDeps(
        { voiceId: "alloy", isDefault: true },
        { provider: "openrouter" },
      );
      const listVoices = modelVoices("en_paul", "fr_marie");

      await expect(
        updateVoiceSpeechModel(deps, actor, { provider: "openrouter", speechModel: "mistral/v" }),
      ).resolves.toMatchObject({ speechModel: "mistral/v" });

      expect(listVoices).toHaveBeenCalledWith("or-key-12345", expect.anything(), {
        model: "mistral/v",
      });
      expect(account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { speechModel: "mistral/v", voiceId: "en_paul" } }),
      );
    });

    it("keeps the current voice when the new model has it", async () => {
      const { deps, account } = speechDeps(
        { voiceId: "alloy", isDefault: true },
        { provider: "openrouter" },
      );
      modelVoices("nova", "alloy");

      await updateVoiceSpeechModel(deps, actor, { provider: "openrouter", speechModel: "a/b" });

      expect(account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { speechModel: "a/b" } }),
      );
    });

    it("still saves the model when the voices cannot be listed", async () => {
      const { deps, account } = speechDeps(
        { voiceId: "alloy", isDefault: true },
        { provider: "openrouter" },
      );
      modelVoices().mockRejectedValue(new Error("catalog down"));

      await expect(
        updateVoiceSpeechModel(deps, actor, { provider: "openrouter", speechModel: "a/b" }),
      ).resolves.toMatchObject({ speechModel: "a/b", voiceId: "alloy" });
      expect(account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { speechModel: "a/b" } }),
      );
    });

    it("keeps the voice when the new model lists none", async () => {
      const { deps, account } = speechDeps(
        { voiceId: "alloy", isDefault: true },
        { provider: "openrouter" },
      );
      modelVoices();

      await updateVoiceSpeechModel(deps, actor, { provider: "openrouter", speechModel: "a/b" });

      expect(account.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { speechModel: "a/b" } }),
      );
    });
  });
});
