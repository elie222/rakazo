import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_VOICE_RECORD,
  deploymentVoiceId,
  deploymentVoiceProviders,
  findDeploymentVoice,
  hasDeploymentVoice,
  resolveDeploymentVoiceEnv,
} from "./deployment-voice.js";
import { listDefaultVoices } from "./own-bot-settings.js";
import type * as VoiceFactory from "./voice-factory.js";
import { createVoiceProvider } from "./voice-factory.js";

vi.mock("./voice-factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof VoiceFactory>()),
  createVoiceProvider: vi.fn(),
}));

const scope = { userId: "user-1", spaceId: "space-1" };
const context = {
  operationId: "test",
  traceId: "test",
  ...scope,
  signal: new AbortController().signal,
};

function prismaWith(
  saved: { provider: string | null; voiceId?: string; cipher: string | null } | null,
) {
  return {
    deploymentSettings: {
      findUnique: vi.fn(async () =>
        saved
          ? {
              defaultVoiceProvider: saved.provider,
              defaultVoiceId: saved.voiceId ?? null,
              defaultVoiceCredentialCipher: saved.cipher,
            }
          : null,
      ),
    },
  } as unknown as PrismaClient;
}

const secrets = {
  load: vi.fn(async (ciphertext: string) => `plain:${ciphertext}`),
  put: vi.fn(),
  delete: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveDeploymentVoiceEnv", () => {
  it("reads the provider, key, voice and speech model", () => {
    expect(
      resolveDeploymentVoiceEnv({
        VOICE_DEFAULT_PROVIDER: " elevenlabs ",
        VOICE_DEFAULT_API_KEY: " test-voice-key ",
        VOICE_DEFAULT_VOICE_ID: "voice-a",
        VOICE_DEFAULT_SPEECH_MODEL: "eleven_flash_v2_5",
      }),
    ).toEqual({
      provider: "elevenlabs",
      apiKey: "test-voice-key",
      voiceId: "voice-a",
      speechModel: "eleven_flash_v2_5",
    });
  });

  it("is off unless a hosted provider and its key are both set", () => {
    expect(resolveDeploymentVoiceEnv({})).toBeNull();
    expect(resolveDeploymentVoiceEnv({ VOICE_DEFAULT_PROVIDER: "cartesia" })).toBeNull();
    expect(resolveDeploymentVoiceEnv({ VOICE_DEFAULT_API_KEY: "test-voice-key" })).toBeNull();
    for (const provider of ["openai-compatible", "macos", "scripted", "unknown"]) {
      expect(
        resolveDeploymentVoiceEnv({
          VOICE_DEFAULT_PROVIDER: provider,
          VOICE_DEFAULT_API_KEY: "test-voice-key",
        }),
      ).toBeNull();
    }
  });

  it("never treats a model key as a voice key", () => {
    expect(
      resolveDeploymentVoiceEnv({
        VOICE_DEFAULT_PROVIDER: "openai",
        OPENAI_API_KEY: "test-model-key",
      }),
    ).toBeNull();
  });

  it("drops a speech model the provider does not take or that is not a model id", () => {
    const env = { VOICE_DEFAULT_PROVIDER: "cartesia", VOICE_DEFAULT_API_KEY: "test-voice-key" };
    expect(
      resolveDeploymentVoiceEnv({ ...env, VOICE_DEFAULT_SPEECH_MODEL: "sonic" })?.speechModel,
    ).toBe("");
    expect(
      resolveDeploymentVoiceEnv({
        ...env,
        VOICE_DEFAULT_PROVIDER: "fish-audio",
        VOICE_DEFAULT_SPEECH_MODEL: "s1\ninjected",
      })?.speechModel,
    ).toBe("");
  });

  it("offers only hosted providers from the catalog", () => {
    expect(deploymentVoiceProviders().map((entry) => entry.id)).toEqual([
      "elevenlabs",
      "openai",
      "cartesia",
      "fish-audio",
      "xai",
    ]);
  });
});

describe("findDeploymentVoice", () => {
  const env = {
    VOICE_DEFAULT_PROVIDER: "cartesia",
    VOICE_DEFAULT_API_KEY: "env-voice-key",
    VOICE_DEFAULT_VOICE_ID: "env-voice",
  };

  it("prefers the admin's saved voice and decrypts its key only when asked", async () => {
    const voice = await findDeploymentVoice(
      prismaWith({ provider: "elevenlabs", voiceId: "saved-voice", cipher: "cipher-1" }),
      secrets,
      env,
    );
    expect(voice).toMatchObject({
      provider: "elevenlabs",
      voiceId: "saved-voice",
      source: "settings",
    });
    expect(secrets.load).not.toHaveBeenCalled();
    await expect(voice?.loadKey()).resolves.toBe("plain:cipher-1");
    expect(secrets.load).toHaveBeenCalledWith("cipher-1", DEPLOYMENT_VOICE_RECORD);
  });

  it("falls back to the environment once the saved voice is cleared", async () => {
    for (const saved of [null, { provider: null, cipher: null }]) {
      const voice = await findDeploymentVoice(prismaWith(saved), secrets, env);
      expect(voice).toMatchObject({
        provider: "cartesia",
        voiceId: "env-voice",
        source: "environment",
      });
      await expect(voice?.loadKey()).resolves.toBe("env-voice-key");
    }
    await expect(findDeploymentVoice(prismaWith(null), secrets, {})).resolves.toBeNull();
  });

  it("ignores a saved row without a key or with a provider it cannot share", async () => {
    await expect(
      findDeploymentVoice(prismaWith({ provider: "elevenlabs", cipher: null }), secrets, {}),
    ).resolves.toBeNull();
    await expect(
      findDeploymentVoice(prismaWith({ provider: "openai-compatible", cipher: "c" }), secrets, {}),
    ).resolves.toBeNull();
  });

  it("tells whether a voice exists without reading a key", async () => {
    await expect(hasDeploymentVoice(prismaWith(null), env)).resolves.toBe(true);
    await expect(
      hasDeploymentVoice(prismaWith({ provider: "openai", cipher: "c" }), {}),
    ).resolves.toBe(true);
    await expect(hasDeploymentVoice(prismaWith(null), {})).resolves.toBe(false);
    expect(secrets.load).not.toHaveBeenCalled();
  });
});

describe("deploymentVoiceId", () => {
  it("uses the chosen voice, else lists the provider's first voice once per key", async () => {
    const listVoices = vi.fn(async () => [
      { id: "first", label: "First" },
      { id: "second", label: "Second" },
    ]);
    await expect(
      deploymentVoiceId(
        { provider: "openai", voiceId: "chosen" },
        "key-a",
        { listVoices },
        context,
      ),
    ).resolves.toBe("chosen");
    expect(listVoices).not.toHaveBeenCalled();
    for (let call = 0; call < 2; call++) {
      await expect(
        deploymentVoiceId({ provider: "openai", voiceId: "" }, "key-a", { listVoices }, context),
      ).resolves.toBe("first");
    }
    expect(listVoices).toHaveBeenCalledOnce();
    await deploymentVoiceId({ provider: "openai", voiceId: "" }, "key-b", { listVoices }, context);
    expect(listVoices).toHaveBeenCalledTimes(2);
  });
});

describe("listDefaultVoices", () => {
  it("lists the deployment's voices for an account without its own connection", async () => {
    const listVoices = vi.fn(async () => [{ id: "voice-a", label: "Voice A" }]);
    vi.mocked(createVoiceProvider).mockReturnValue({ listVoices } as never);
    const prisma = {
      ...prismaWith({ provider: "fish-audio", voiceId: "voice-a", cipher: "cipher-1" }),
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userVoicePreference: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;

    const revealed = vi.fn();
    await expect(
      listDefaultVoices({ prisma, secretStore: secrets }, scope, context, revealed),
    ).resolves.toEqual([{ id: "voice-a", label: "Voice A" }]);
    expect(createVoiceProvider).toHaveBeenCalledWith("fish-audio");
    expect(listVoices).toHaveBeenCalledWith("plain:cipher-1", context);
    // The run redacts the deployment's key from whatever the provider sends back.
    expect(revealed).toHaveBeenCalledExactlyOnceWith("plain:cipher-1");
  });
});
