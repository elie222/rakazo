import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { RouterHandler } from "../router-test-support.js";
import { appHandler, handle } from "../router-test-support.js";
import { deploymentVoiceFromEnv } from "../voice/deployment-config.js";

describe("bot profile setting saves", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const spark = "gpt-5.3-codex-spark";
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";

  async function call(handler: RouterHandler, path: string, body: unknown) {
    const response = await handle(
      handler,
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  function storedBot(modelId: string) {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: "bot-1",
      spaceId: actor.spaceId,
      userId: actor.userId,
      name: "Ada",
      title: "",
      description: "",
      instructions: "",
      color: "ink",
      notifyOnFinish: true,
      pinned: false,
      position: 0,
      sectionId: null,
      archivedAt: null,
      parentBotId: null,
      memoryScope: null,
      createdAt: now,
      updatedAt: now,
      voiceProvider: "provider-a" as string | null,
      voiceId: "bot-voice",
      autoSpeak: false,
      modelProvider: "openai-codex",
      modelId,
      thinkingLevel: null,
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      webhookSecretId: null,
      spawnKey: null,
      thread: { id: "thread-1", reads: [], messages: [], runs: [] },
      computer: null,
      runs: [],
    };
  }

  function credentialRow(id: string, secretId: string) {
    return {
      id,
      userId: actor.userId,
      provider: "openai-codex",
      label: "ChatGPT",
      secretId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  function saveDeps(options: {
    modelId: string;
    voiceProvider?: string | null;
    defaultVoiceProvider?: string | null;
    spaceVoiceOverride?: boolean;
    preferences: (args: { where: { modelId?: string; credential?: { provider?: string } } }) => {
      credential: ReturnType<typeof credentialRow>;
      modelId: string;
    } | null;
  }) {
    const bot = storedBot(options.modelId);
    if (options.voiceProvider !== undefined) bot.voiceProvider = options.voiceProvider;
    const voicePreference = options.defaultVoiceProvider
      ? {
          credential: {
            id: "voice-credential",
            userId: actor.userId,
            provider: options.defaultVoiceProvider,
            secretId: "voice-secret",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          isDefault: true,
          voiceId: "settings-voice",
          speechModel: null,
        }
      : null;
    const userVoicePreferenceFindFirst = vi.fn(async () => voicePreference);
    const spaceVoicePreferenceFindFirst = vi.fn(async () => voicePreference);
    const voiceOverrideFindUnique = vi.fn(async () =>
      options.spaceVoiceOverride ? { setting: "voice" } : null,
    );
    const preferenceFindFirst = vi.fn(options.preferences);
    const secretFindFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-api") {
        return { id: "secret-api", ciphertext: "cipher-api" };
      }
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const botUpdate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
      id: bot.id,
      name: "Ada renamed",
      title: bot.title,
      description: bot.description,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      bot: { update: botUpdate },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const prisma = {
      $queryRaw: vi.fn(async () => []),
      bot: {
        findFirst: vi.fn(async () => bot),
        findMany: vi.fn(async () => [{ ...bot, name: "Ada renamed" }]),
        update: botUpdate,
      },
      userModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: voiceOverrideFindUnique },
      userVoicePreference: { findFirst: userVoicePreferenceFindFirst },
      spaceVoicePreference: { findFirst: spaceVoicePreferenceFindFirst },
      secret: { findFirst: secretFindFirst },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const deps = {
      prisma,
      secrets: {
        load: (ciphertext: string) => (ciphertext === "cipher-oauth" ? oauth : apiKey),
      },
      events: { notify: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps;
    return {
      deps,
      preferenceFindFirst,
      secretFindFirst,
      botUpdate,
      userVoicePreferenceFindFirst,
      spaceVoicePreferenceFindFirst,
      voiceOverrideFindUnique,
      eventCreate: tx.event.create,
      handler: appHandler(deps),
    };
  }

  it("keeps hosted speech inherited rather than pinning its provider to an unowned voice", async () => {
    const { deps, botUpdate, handler, secretFindFirst } = saveDeps({
      modelId: spark,
      preferences: () => null,
      voiceProvider: null,
    });
    const price = {
      model: "speech",
      unit: "characters",
      microsPerUnit: 1,
      maxRequestMicros: 100,
      source: "https://pricing.example/speech",
      version: "test",
    };
    deps.env.deploymentVoice = deploymentVoiceFromEnv(
      JSON.stringify({
        provider: "scripted",
        allowUnmeteredUsage: true,
        voiceId: "hosted-voice",
        connection: { plaintext: "fake-operator-key" },
        pricing: { synthesize: price, transcribe: { ...price, unit: "seconds" } },
      }),
    );
    expect(
      (await call(handler, "bots/update", { botId: "bot-1", voiceId: "custom-voice" })).status,
    ).toBe(400);
    expect(botUpdate).not.toHaveBeenCalled();
    expect(
      (
        await call(handler, "bots/update", {
          botId: "bot-1",
          voiceProvider: null,
          voiceId: null,
        })
      ).status,
    ).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ voiceProvider: null, voiceId: null }),
      }),
    );
    expect(secretFindFirst).not.toHaveBeenCalled();
  });

  it("keeps an unrelated profile save off the roster-event path when speech values are unchanged", async () => {
    const { botUpdate, eventCreate, handler } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      notifyOnFinish: false,
      autoSpeak: false,
    });
    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notifyOnFinish: false }),
      }),
    );
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("signals an actual read-aloud change to other clients", async () => {
    const { eventCreate, handler } = saveDeps({ modelId: spark, preferences: () => null });
    expect((await call(handler, "bots/update", { botId: "bot-1", autoSpeak: true })).status).toBe(
      200,
    );
    expect(eventCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "bot.updated" }),
      }),
    );
  });

  it.each(["provider-b", null])(
    "clears the voice when switching provider to %s",
    async (voiceProvider) => {
      const { botUpdate, eventCreate, handler } = saveDeps({
        modelId: spark,
        preferences: () => null,
      });
      const response = await call(handler, "bots/update", {
        botId: "bot-1",
        voiceProvider,
      });
      expect(response.status).toBe(200);
      expect(botUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ voiceProvider, voiceId: null }),
        }),
      );
      expect(eventCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: "bot.updated" }) }),
      );
    },
  );

  it.each(["provider-a", "provider-b"])(
    "keeps an explicit voice when saving provider %s",
    async (voiceProvider) => {
      const { botUpdate, handler } = saveDeps({ modelId: spark, preferences: () => null });
      const response = await call(handler, "bots/update", {
        botId: "bot-1",
        voiceProvider,
        voiceId: "new-voice",
      });
      expect(response.status).toBe(200);
      expect(botUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ voiceProvider, voiceId: "new-voice" }),
        }),
      );
    },
  );

  it("pins a bare voice selection to the bot's provider without reading Settings", async () => {
    const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      voiceId: "new-voice",
    });
    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bot-1", voiceProvider: "provider-a" },
        data: expect.objectContaining({ voiceProvider: "provider-a", voiceId: "new-voice" }),
      }),
    );
    expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
  });

  it("classifies pinning a legacy voice as a voice change without exposing its values", async () => {
    const { deps, botUpdate } = saveDeps({
      modelId: spark,
      preferences: () => null,
      voiceProvider: null,
      defaultVoiceProvider: "provider-b",
    });
    const capture = vi.fn();
    const handler = appHandler({
      ...deps,
      analytics: { capture, flush: async () => undefined },
    });
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      voiceId: "bot-voice",
    });
    expect(response.status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ voiceProvider: "provider-b", voiceId: "bot-voice" }),
      }),
    );
    expect(capture.mock.calls).toEqual([
      [actor.userId, { name: "bot_setting_changed", setting: "voice" }],
    ]);
  });

  it.each([false, true])(
    "pins a bare voice to the actor's effective Settings provider (Space override: %s)",
    async (spaceVoiceOverride) => {
      const {
        botUpdate,
        handler,
        userVoicePreferenceFindFirst,
        spaceVoicePreferenceFindFirst,
        secretFindFirst,
      } = saveDeps({
        modelId: spark,
        preferences: () => null,
        voiceProvider: null,
        defaultVoiceProvider: "provider-b",
        spaceVoiceOverride,
      });
      const response = await call(handler, "bots/update", {
        botId: "bot-1",
        voiceId: "new-voice",
      });
      expect(response.status).toBe(200);
      expect(botUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bot-1", voiceProvider: null },
          data: expect.objectContaining({ voiceProvider: "provider-b", voiceId: "new-voice" }),
        }),
      );
      if (spaceVoiceOverride) {
        expect(spaceVoicePreferenceFindFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { userId: actor.userId, spaceId: actor.spaceId, isDefault: true },
          }),
        );
        expect(userVoicePreferenceFindFirst).not.toHaveBeenCalled();
      } else {
        expect(userVoicePreferenceFindFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId: actor.userId, isDefault: true } }),
        );
        expect(spaceVoicePreferenceFindFirst).not.toHaveBeenCalled();
      }
      expect(secretFindFirst).not.toHaveBeenCalled();
    },
  );

  it("binds a custom voice sent with Default to Settings rather than the old provider", async () => {
    const { botUpdate, handler } = saveDeps({
      modelId: spark,
      preferences: () => null,
      defaultVoiceProvider: "provider-b",
    });
    expect(
      (
        await call(handler, "bots/update", {
          botId: "bot-1",
          voiceProvider: null,
          voiceId: "new-voice",
        })
      ).status,
    ).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ voiceProvider: "provider-b", voiceId: "new-voice" }),
      }),
    );
  });

  it.each([undefined, null])(
    "refuses a custom voice without a current or Settings provider (%s)",
    async (voiceProvider) => {
      const { botUpdate, handler } = saveDeps({
        modelId: spark,
        preferences: () => null,
        voiceProvider: null,
      });
      const response = await call(handler, "bots/update", {
        botId: "bot-1",
        voiceProvider,
        voiceId: "new-voice",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        json: { code: "BAD_REQUEST", message: "Connect a voice provider first." },
      });
      expect(botUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(["provider-a", null])(
    "clears only the voice while preserving the bot's provider (%s)",
    async (voiceProvider) => {
      const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
        modelId: spark,
        preferences: () => null,
        voiceProvider,
        defaultVoiceProvider: "provider-b",
      });
      expect((await call(handler, "bots/update", { botId: "bot-1", voiceId: null })).status).toBe(
        200,
      );
      expect(botUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bot-1", voiceProvider },
          data: expect.objectContaining({ voiceProvider, voiceId: null }),
        }),
      );
      expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
    },
  );

  it("explicitly resets both overrides without looking up Settings", async () => {
    const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });
    expect(
      (
        await call(handler, "bots/update", {
          botId: "bot-1",
          voiceProvider: null,
          voiceId: null,
        })
      ).status,
    ).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ voiceProvider: null, voiceId: null }),
      }),
    );
    expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
  });

  it("preserves the voice when resaving the same provider", async () => {
    const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });
    expect(
      (
        await call(handler, "bots/update", {
          botId: "bot-1",
          voiceProvider: "provider-a",
        })
      ).status,
    ).toBe(200);
    expect(botUpdate.mock.calls[0]![0].data).toMatchObject({ voiceProvider: "provider-a" });
    expect(botUpdate.mock.calls[0]![0].data).not.toHaveProperty("voiceId");
    expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
  });

  it("keeps unrelated saves free of voice lookups and writes", async () => {
    const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
      modelId: spark,
      preferences: () => null,
    });
    expect(
      (await call(handler, "bots/update", { botId: "bot-1", name: "Ada renamed" })).status,
    ).toBe(200);
    expect(botUpdate.mock.calls[0]![0].data).not.toHaveProperty("voiceProvider");
    expect(botUpdate.mock.calls[0]![0].data).not.toHaveProperty("voiceId");
    expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
  });

  it("merges an inferred provider guard with the caller's expected settings", async () => {
    const { botUpdate, handler } = saveDeps({ modelId: spark, preferences: () => null });
    const input = {
      botId: "bot-1",
      voiceId: "new-voice",
      expectedSettings: { autoSpeak: false, voiceId: "bot-voice" },
    };
    expect((await call(handler, "bots/update", input)).status).toBe(200);
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "bot-1",
          voiceProvider: "provider-a",
          autoSpeak: false,
          voiceId: "bot-voice",
        },
      }),
    );
    botUpdate.mockRejectedValueOnce(Object.assign(new Error("No record"), { code: "P2025" }));
    const changed = await call(handler, "bots/update", input);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      json: { code: "CONFLICT", message: "Settings changed; review the current settings first." },
    });
  });

  it("translates an inferred provider race without caller-supplied expectations to conflict", async () => {
    const { botUpdate, handler } = saveDeps({ modelId: spark, preferences: () => null });
    botUpdate.mockRejectedValueOnce(Object.assign(new Error("No record"), { code: "P2025" }));
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      voiceId: "new-voice",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      json: { code: "CONFLICT", message: "Settings changed; review the current settings first." },
    });
  });

  it("refuses to replace the caller's conflicting expected provider with the inferred one", async () => {
    const { botUpdate, handler, voiceOverrideFindUnique } = saveDeps({
      modelId: spark,
      preferences: () => null,
      voiceProvider: null,
      defaultVoiceProvider: "provider-b",
    });
    const response = await call(handler, "bots/update", {
      botId: "bot-1",
      voiceId: "new-voice",
      expectedSettings: { voiceProvider: "provider-a" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      json: { code: "CONFLICT", message: "Settings changed; review the current settings first." },
    });
    expect(botUpdate).not.toHaveBeenCalled();
    expect(voiceOverrideFindUnique).not.toHaveBeenCalled();
  });
});
