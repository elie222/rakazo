import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import {
  loadVoiceStatus,
  prepareVoice,
  synthesizeVoice,
  toVoiceStatus,
  transcribeInboundVoice,
} from "./voice.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

describe("deployment voice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const ownPreference = {
    isDefault: true,
    voiceId: "own-voice",
    speechModel: null,
    credential: {
      id: "cred-1",
      userId: actor.userId,
      provider: "fish-audio",
      secretId: "secret-1",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };

  function voiceDeps(options: {
    own?: boolean;
    saved?: { provider: string; voiceId: string } | null;
    spaceOverride?: boolean;
  }) {
    const prisma = {
      spaceSettingOverride: {
        findUnique: vi.fn().mockResolvedValue(options.spaceOverride ? { setting: "voice" } : null),
      },
      userVoicePreference: {
        findFirst: vi.fn().mockResolvedValue(options.own ? ownPreference : null),
      },
      spaceVoicePreference: { findFirst: vi.fn().mockResolvedValue(null) },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "own" }) },
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue(
          options.saved
            ? {
                defaultVoiceProvider: options.saved.provider,
                defaultVoiceId: options.saved.voiceId,
                defaultVoiceCredentialCipher: "saved-cipher",
              }
            : null,
        ),
      },
    };
    const secrets = {
      load: vi.fn(async (ciphertext: string) =>
        ciphertext === "saved-cipher" ? "saved-deployment-key" : "own-key",
      ),
      put: vi.fn(),
    };
    return { prisma, secrets } as unknown as VoiceDeps & { secrets: typeof secrets };
  }

  function speaker() {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    const listVoices = vi.fn().mockResolvedValue([{ id: "first-voice", label: "First" }]);
    const create = vi
      .spyOn(adapters, "createVoiceProvider")
      .mockReturnValue({ synthesize, listVoices } as never);
    return { synthesize, listVoices, create };
  }

  function useEnvironmentVoice(voiceId?: string) {
    vi.stubEnv("VOICE_DEFAULT_PROVIDER", "cartesia");
    vi.stubEnv("VOICE_DEFAULT_API_KEY", "env-deployment-key");
    if (voiceId) vi.stubEnv("VOICE_DEFAULT_VOICE_ID", voiceId);
  }

  it("prefers the account's own connection over the deployment's voice", async () => {
    useEnvironmentVoice("env-voice");
    const { synthesize, create } = speaker();
    const deps = voiceDeps({ own: true, saved: { provider: "elevenlabs", voiceId: "saved" } });

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(create).toHaveBeenCalledWith("fish-audio", expect.anything());
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "own-key",
      voiceId: "own-voice",
    });
    await expect(loadVoiceStatus(deps, actor)).resolves.not.toHaveProperty("deployment");
  });

  it("speaks with the admin's saved voice over the environment's", async () => {
    useEnvironmentVoice("env-voice");
    const { synthesize, create } = speaker();
    const deps = voiceDeps({ saved: { provider: "elevenlabs", voiceId: "saved-voice" } });

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(create).toHaveBeenCalledWith("elevenlabs", expect.anything());
    expect(deps.secrets.load).toHaveBeenCalledWith("saved-cipher", "deployment-voice");
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "saved-deployment-key",
      voiceId: "saved-voice",
    });
    await expect(loadVoiceStatus(deps, actor)).resolves.toEqual({
      configured: true,
      ready: true,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "saved-voice",
      deployment: true,
    });
  });

  it("is not ready with an admin's voice that names none", async () => {
    speaker();
    const deps = voiceDeps({ saved: { provider: "elevenlabs", voiceId: "" } });
    await expect(loadVoiceStatus(deps, actor)).resolves.toMatchObject({
      configured: true,
      ready: false,
      deployment: true,
    });
  });

  it("falls back to the environment's voice and its provider's first voice", async () => {
    useEnvironmentVoice();
    const { synthesize, listVoices, create } = speaker();
    const deps = voiceDeps({});

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(create).toHaveBeenCalledWith("cartesia", expect.anything());
    expect(listVoices).toHaveBeenCalledWith("env-deployment-key", expect.anything());
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "env-deployment-key",
      voiceId: "first-voice",
    });
    // A bot's own voice still wins over the deployment's.
    await synthesizeVoice(deps, actor, { text: "Hello", voiceId: "bot-voice" });
    expect(synthesize.mock.calls[1]?.[0]).toMatchObject({ voiceId: "bot-voice" });
    await expect(loadVoiceStatus(deps, actor)).resolves.toMatchObject({
      ready: true,
      transcribe: false,
      provider: "cartesia",
      deployment: true,
    });
  });

  it("covers a Space that overrides voice without a connection chosen there", async () => {
    useEnvironmentVoice("env-voice");
    const { synthesize } = speaker();
    const deps = voiceDeps({ own: true, spaceOverride: true });

    await synthesizeVoice(deps, actor, { text: "Hello" });
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "env-deployment-key",
      voiceId: "env-voice",
    });
    await synthesizeVoice(deps, actor, { text: "Hello", scope: "account" });
    expect(synthesize.mock.calls[1]?.[0]).toMatchObject({ apiKey: "own-key" });
  });

  it("ignores an environment voice without a key or with an unknown provider", async () => {
    speaker();
    vi.stubEnv("VOICE_DEFAULT_PROVIDER", "cartesia");
    vi.stubEnv("VOICE_DEFAULT_API_KEY", "");
    await expect(prepareVoice(voiceDeps({}), actor, { text: "Hello" })).resolves.toEqual({
      ready: false,
      utterances: [],
    });
    vi.stubEnv("VOICE_DEFAULT_PROVIDER", "openai-compatible");
    vi.stubEnv("VOICE_DEFAULT_API_KEY", "env-deployment-key");
    await expect(loadVoiceStatus(voiceDeps({}), actor)).resolves.toEqual(toVoiceStatus(null));
  });

  it("transcribes with the deployment's voice when the owner has none", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "spoken words" });
    const create = vi
      .spyOn(adapters, "createVoiceProvider")
      .mockReturnValue({ transcribe } as never);
    vi.stubEnv("VOICE_DEFAULT_PROVIDER", "openai");
    vi.stubEnv("VOICE_DEFAULT_API_KEY", "deployment-voice-key");
    await expect(
      transcribeInboundVoice(voiceDeps({}), actor, {
        audio: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).resolves.toBe("spoken words");
    expect(create).toHaveBeenCalledWith("openai", expect.anything());
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "deployment-voice-key" }),
      expect.anything(),
    );
  });
});
