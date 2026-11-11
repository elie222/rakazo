import { createRouterClient } from "@orpc/server";
import * as adapters from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDeploymentVoiceSettings,
  listDeploymentVoices,
  updateDeploymentVoiceSettings,
} from "./deployment-voice.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

/** An in-memory deployment settings row and secret store behind the calls the settings make. */
function makeDeps(options: { admin?: boolean } = {}) {
  const state = {
    settings: null as null | {
      defaultVoiceProvider: string | null;
      defaultVoiceId: string | null;
      defaultVoiceCredentialCipher: string | null;
    },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: NonNullable<typeof state.settings> }) => {
        state.settings = { ...state.settings, ...update };
        return state.settings;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `cipher-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => state.secrets.get(ciphertext) ?? ""),
      delete: vi.fn(async (ciphertext: string) => {
        state.secrets.delete(ciphertext);
      }),
    },
    env: { adminEmails: options.admin === false ? [] : ["admin@example.com"] },
  };
  return { deps, state, prisma };
}

function voiceProvider(verified: { ok: boolean; message?: string } = { ok: true }) {
  const provider = {
    verify: vi.fn(async () => verified),
    listVoices: vi.fn(async () => [
      { id: "first-voice", label: "First" },
      { id: "second-voice", label: "Second" },
    ]),
  };
  const create = vi
    .spyOn(adapters, "createVoiceProvider")
    .mockReturnValue(provider as unknown as ReturnType<typeof adapters.createVoiceProvider>);
  return { provider, create };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("deployment voice settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    const { provider } = voiceProvider();
    await expect(getDeploymentVoiceSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(listDeploymentVoices(deps, actor)).rejects.toThrow("Admins only");
    await expect(
      updateDeploymentVoiceSettings(deps, actor, {
        provider: "elevenlabs",
        apiKey: "test-voice-key",
      }),
    ).rejects.toThrow("Admins only");
    await expect(
      updateDeploymentVoiceSettings(deps, actor, { provider: null, apiKey: "" }),
    ).rejects.toThrow("Admins only");
    expect(provider.verify).not.toHaveBeenCalled();
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("verifies the key, stores it encrypted for the deployment and never returns it", async () => {
    const { deps, state } = makeDeps();
    const { provider, create } = voiceProvider();

    const saved = await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: " test-voice-key ",
    });

    expect(create).toHaveBeenCalledWith("elevenlabs");
    expect(provider.verify).toHaveBeenCalledWith("test-voice-key", expect.anything());
    expect(deps.secrets.put).toHaveBeenCalledWith("test-voice-key", expect.anything(), {
      recordId: "deployment-voice",
    });
    expect(state.settings).toEqual({
      defaultVoiceProvider: "elevenlabs",
      // No voice chosen: the provider's first one.
      defaultVoiceId: "first-voice",
      defaultVoiceCredentialCipher: "cipher-1",
    });
    expect(saved).toMatchObject({
      provider: "elevenlabs",
      voiceId: "first-voice",
      keySaved: true,
      environmentProvider: null,
    });
    expect(saved.providers.map((entry) => entry.id)).toContain("elevenlabs");
    expect(saved.providers.map((entry) => entry.id)).not.toContain("openai-compatible");
    expect(JSON.stringify(saved)).not.toContain("test-voice-key");
    expect(await getDeploymentVoiceSettings(deps, actor)).toEqual(saved);
  });

  it("keeps the saved key when the field is left blank and drops the replaced ciphertext", async () => {
    const { deps, state } = makeDeps();
    const { provider } = voiceProvider();
    await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "test-voice-key",
    });

    const saved = await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "",
      voiceId: "second-voice",
    });

    expect(provider.verify).toHaveBeenLastCalledWith("test-voice-key", expect.anything());
    expect(saved.voiceId).toBe("second-voice");
    expect(state.secrets.get(state.settings?.defaultVoiceCredentialCipher ?? "")).toBe(
      "test-voice-key",
    );
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher-1", "deployment-voice");
    expect(state.secrets.size).toBe(1);
  });

  it("saves only a voice the key can use", async () => {
    const { deps } = makeDeps();
    const { provider } = voiceProvider();
    // A voice from the replaced key's account gives way to one this key has.
    const replaced = await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "test-voice-key",
      voiceId: "old-account-voice",
    });
    expect(replaced.voiceId).toBe("first-voice");
    // A provider that cannot list its voices keeps the one asked for.
    provider.listVoices.mockRejectedValueOnce(new Error("listing unavailable"));
    const unlisted = await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "",
      voiceId: "asked-voice",
    });
    expect(unlisted.voiceId).toBe("asked-voice");
  });

  it("refuses a key whose account has no voices to speak with", async () => {
    const { deps, state } = makeDeps();
    const { provider } = voiceProvider();
    provider.listVoices.mockResolvedValueOnce([]);
    await expect(
      updateDeploymentVoiceSettings(deps, actor, {
        provider: "elevenlabs",
        apiKey: "test-voice-key",
      }),
    ).rejects.toThrow("no voices yet");
    expect(state.settings?.defaultVoiceProvider ?? null).toBeNull();
  });

  it("needs a new key for another provider", async () => {
    const { deps, state } = makeDeps();
    const { provider } = voiceProvider();
    await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "test-voice-key",
    });
    await expect(
      updateDeploymentVoiceSettings(deps, actor, { provider: "cartesia", apiKey: "" }),
    ).rejects.toThrow("Enter an API key.");
    expect(provider.verify).toHaveBeenCalledOnce();
    expect(state.settings?.defaultVoiceProvider).toBe("elevenlabs");
  });

  it("refuses a rejected key or a provider a deployment cannot share without saving", async () => {
    const { deps, state } = makeDeps();
    voiceProvider({ ok: false, message: "That key was rejected." });
    await expect(
      updateDeploymentVoiceSettings(deps, actor, {
        provider: "elevenlabs",
        apiKey: "test-voice-key",
      }),
    ).rejects.toThrow("That key was rejected.");
    await expect(
      updateDeploymentVoiceSettings(deps, actor, {
        provider: "openai-compatible",
        apiKey: "test-voice-key",
      }),
    ).rejects.toThrow("Unknown voice provider.");
    expect(state.settings).toBeNull();
    expect(deps.secrets.put).not.toHaveBeenCalled();
  });

  it("removes the new ciphertext when saving it fails", async () => {
    const { deps, prisma, state } = makeDeps();
    voiceProvider();
    prisma.deploymentSettings.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateDeploymentVoiceSettings(deps, actor, {
        provider: "elevenlabs",
        apiKey: "test-voice-key",
      }),
    ).rejects.toThrow("database unavailable");
    expect(deps.secrets.delete).toHaveBeenCalledWith("cipher-1", "deployment-voice");
    expect(state.secrets.size).toBe(0);
  });

  it("clears the saved voice so the environment's applies again", async () => {
    vi.stubEnv("VOICE_DEFAULT_PROVIDER", "cartesia");
    vi.stubEnv("VOICE_DEFAULT_API_KEY", "env-voice-key");
    const { deps, state } = makeDeps();
    voiceProvider();
    await updateDeploymentVoiceSettings(deps, actor, {
      provider: "elevenlabs",
      apiKey: "test-voice-key",
    });

    const cleared = await updateDeploymentVoiceSettings(deps, actor, {
      provider: null,
      apiKey: "",
    });

    expect(cleared).toMatchObject({
      provider: null,
      voiceId: "",
      keySaved: false,
      environmentProvider: "cartesia",
    });
    expect(JSON.stringify(cleared)).not.toContain("env-voice-key");
    expect(state.settings).toEqual({
      defaultVoiceProvider: null,
      defaultVoiceId: null,
      defaultVoiceCredentialCipher: null,
    });
    expect(state.secrets.size).toBe(0);
  });

  it("lists the saved provider's voices with its saved key", async () => {
    const { deps } = makeDeps();
    const { provider } = voiceProvider();
    await expect(listDeploymentVoices(deps, actor)).resolves.toEqual([]);
    await updateDeploymentVoiceSettings(deps, actor, {
      provider: "fish-audio",
      apiKey: "test-voice-key",
      voiceId: "second-voice",
    });
    provider.listVoices.mockClear();

    await expect(listDeploymentVoices(deps, actor)).resolves.toHaveLength(2);
    expect(provider.listVoices).toHaveBeenCalledWith("test-voice-key", expect.anything());
  });
});

describe("deployment voice routes", () => {
  it("keep the settings from non-admins while their voice status names the deployment", async () => {
    const { deps, state, prisma } = makeDeps({ admin: false });
    state.settings = {
      defaultVoiceProvider: "elevenlabs",
      defaultVoiceId: "voice-a",
      defaultVoiceCredentialCipher: "cipher-saved",
    };
    Object.assign(prisma, {
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userVoicePreference: { findFirst: vi.fn(async () => null) },
    });
    const client = createRouterClient(createRouter(deps as unknown as RouterDeps), {
      context: { actor } as never,
    });

    for (const call of [
      () => client.voice.deployment.get(),
      () => client.voice.deployment.voices(),
      () => client.voice.deployment.update({ provider: null }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const status = await client.voice.status();
    expect(status).toEqual({
      configured: true,
      ready: true,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "voice-a",
      deployment: true,
    });
    expect(deps.secrets.load).not.toHaveBeenCalled();
    expect(state.settings.defaultVoiceCredentialCipher).toBe("cipher-saved");
  });
});
