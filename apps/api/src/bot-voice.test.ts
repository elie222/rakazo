import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import { mountVoiceHttpRoutes, prepareVoice, synthesizeVoice, voiceStatus } from "./voice.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

function fixture(
  options: {
    voiceProvider?: string | null;
    voiceId?: string | null;
    defaultProvider?: string | null;
    settingsVoice?: string;
    disconnected?: string;
    spaceOverride?: boolean;
    inaccessibleBot?: boolean;
    inaccessibleSecret?: boolean;
  } = {},
) {
  const preference = (scope: string) =>
    vi.fn(async ({ where }: { where: { credential?: { provider: string } } }) => {
      const provider =
        where.credential?.provider ??
        (options.defaultProvider === undefined ? "provider-a" : options.defaultProvider);
      if (!provider || provider === options.disconnected) return null;
      return {
        isDefault: provider === (options.defaultProvider ?? "provider-a"),
        voiceId: options.settingsVoice ?? `${scope}-${provider}`,
        speechModel: null,
        credential: {
          id: `credential-${provider}`,
          userId: actor.userId,
          provider,
          secretId: `secret-${provider}`,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      };
    });
  const prisma = {
    bot: {
      findFirst: vi.fn(async () =>
        options.inaccessibleBot
          ? null
          : { voiceProvider: options.voiceProvider ?? null, voiceId: options.voiceId ?? null },
      ),
    },
    spaceSettingOverride: {
      findUnique: vi.fn(async () => (options.spaceOverride ? { setting: "voice" } : null)),
    },
    userVoicePreference: { findFirst: preference("account") },
    spaceVoicePreference: { findFirst: preference("space") },
    userVoiceCredential: { findFirst: vi.fn(async () => null) },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        options.inaccessibleSecret ? null : { id: where.id, ciphertext: `cipher-${where.id}` },
      ),
    },
  };
  const secrets = { load: vi.fn(async () => "test-key"), put: vi.fn() };
  const synthesize = vi
    .fn()
    .mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
  const createProvider = vi
    .spyOn(adapters, "createVoiceProvider")
    .mockReturnValue({ synthesize } as never);
  return {
    deps: { prisma, secrets } as unknown as VoiceDeps,
    prisma,
    secrets,
    synthesize,
    createProvider,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bot voice", () => {
  it("inherits changes to the Settings default provider and voice live", async () => {
    const options: { defaultProvider: string; settingsVoice?: string } = {
      defaultProvider: "provider-a",
    };
    const { deps, synthesize, createProvider } = fixture(options);
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(createProvider).toHaveBeenLastCalledWith("provider-a", expect.anything());
    expect(synthesize.mock.calls[0]?.[0].voiceId).toBe("account-provider-a");

    options.defaultProvider = "provider-b";
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(createProvider).toHaveBeenLastCalledWith("provider-b", expect.anything());
    expect(synthesize.mock.calls[1]?.[0].voiceId).toBe("account-provider-b");

    options.settingsVoice = "updated-settings-voice";
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(synthesize.mock.calls[2]?.[0].voiceId).toBe("updated-settings-voice");
  });

  it("uses the bot voice when its provider follows Settings", async () => {
    const { deps, synthesize, createProvider } = fixture({ voiceId: "bot-voice" });
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(createProvider).toHaveBeenLastCalledWith("provider-a", expect.anything());
    expect(synthesize.mock.calls[0]?.[0].voiceId).toBe("bot-voice");
  });

  it("uses a bot provider's Settings voice even when there is no default provider", async () => {
    const { deps, synthesize, createProvider, secrets } = fixture({
      voiceProvider: "provider-b",
      defaultProvider: null,
    });
    await expect(voiceStatus(deps, actor, { botId: "bot-1" })).resolves.toEqual({
      configured: true,
      ready: true,
      transcribe: false,
      provider: "provider-b",
      voiceId: "account-provider-b",
    });
    expect(secrets.load).not.toHaveBeenCalled();
    await expect(prepareVoice(deps, actor, { text: "Hello", botId: "bot-1" })).resolves.toEqual({
      ready: true,
      utterances: ["Hello"],
    });
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(createProvider).toHaveBeenLastCalledWith("provider-b", expect.anything());
    expect(synthesize.mock.calls[0]?.[0].voiceId).toBe("account-provider-b");
  });

  it("keeps dictation status on the default provider when the bot overrides speech", async () => {
    vi.spyOn(adapters, "voiceCatalogEntry").mockImplementation((provider) =>
      provider === "provider-a" ? ({ transcribe: true } as never) : undefined,
    );
    const { deps, secrets } = fixture({ voiceProvider: "provider-b", voiceId: "bot-voice" });
    await expect(voiceStatus(deps, actor, { botId: "bot-1" })).resolves.toMatchObject({
      ready: true,
      transcribe: true,
      provider: "provider-b",
      voiceId: "bot-voice",
    });
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("previews an explicit provider and its default voice instead of the saved bot voice", async () => {
    const { deps, synthesize, createProvider } = fixture({
      voiceProvider: "provider-b",
      voiceId: "saved-bot-voice",
    });
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);
    const response = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", botId: "bot-1", provider: "provider-a" }),
    });
    expect(response.status).toBe(200);
    expect(createProvider).toHaveBeenLastCalledWith("provider-a", expect.anything());
    expect(synthesize.mock.calls[0]?.[0].voiceId).toBe("account-provider-a");

    await synthesizeVoice(deps, actor, {
      text: "Hello",
      botId: "bot-1",
      provider: "provider-b",
      voiceId: "draft-voice",
    });
    expect(synthesize.mock.calls[1]?.[0].voiceId).toBe("draft-voice");
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1", provider: "provider-b" });
    expect(synthesize.mock.calls[2]?.[0].voiceId).toBe("account-provider-b");
  });

  it("does not fall back to the default when the configured bot provider is disconnected", async () => {
    const { deps, prisma, synthesize } = fixture({
      voiceProvider: "provider-b",
      voiceId: "bot-voice",
      disconnected: "provider-b",
    });
    await expect(prepareVoice(deps, actor, { text: "Hello", botId: "bot-1" })).resolves.toEqual({
      ready: false,
      utterances: [],
    });
    await expect(
      synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" }),
    ).rejects.toBeInstanceOf(adapters.NoVoiceConfigured);
    await expect(voiceStatus(deps, actor, { botId: "bot-1" })).resolves.toMatchObject({
      ready: false,
    });
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
    expect(prisma.userVoiceCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: actor.userId, provider: "provider-b" } }),
    );
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("reads only the caller's provider preference in the effective Space scope", async () => {
    const { deps, prisma, synthesize } = fixture({
      voiceProvider: "provider-b",
      spaceOverride: true,
    });
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" });
    expect(synthesize.mock.calls[0]?.[0].voiceId).toBe("space-provider-b");
    expect(prisma.spaceVoicePreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          credential: { provider: "provider-b" },
        },
      }),
    );
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-provider-b", userId: actor.userId, spaceId: null },
    });
    await synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1", scope: "account" });
    expect(synthesize.mock.calls[1]?.[0].voiceId).toBe("account-provider-b");
  });

  it("refuses a bot outside the active Space before accessing credentials", async () => {
    const { deps, prisma, secrets } = fixture({ inaccessibleBot: true });
    await expect(
      synthesizeVoice(deps, actor, { text: "Hello", botId: "other-bot" }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(voiceStatus(deps, actor, { botId: "other-bot" })).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "other-bot", spaceId: actor.spaceId },
      select: { voiceProvider: true, voiceId: true },
    });
    expect(prisma.userVoicePreference.findFirst).not.toHaveBeenCalled();
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("does not open a voice secret unavailable to the caller", async () => {
    const { deps, secrets, synthesize } = fixture({
      voiceProvider: "provider-b",
      inaccessibleSecret: true,
    });
    await expect(
      synthesizeVoice(deps, actor, { text: "Hello", botId: "bot-1" }),
    ).rejects.toBeInstanceOf(adapters.NoVoiceConfigured);
    expect(secrets.load).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });
});
