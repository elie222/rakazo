import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectVoiceCredential,
  fishSpeechModelValue,
  MAX_SPEAK_REQUEST_BYTES,
  MAX_TRANSCRIBE_REQUEST_BYTES,
  mountVoiceHttpRoutes,
  persistVoiceCredential,
  synthesizeVoice,
  toVoiceCredential,
  toVoiceStatus,
  updateVoiceSpeechModel,
  type VoiceDeps,
  voiceChoicesChanged,
  voiceCredentialPlaintext,
  voiceCredentialServer,
} from "./voice.js";

describe("toVoiceStatus", () => {
  it("treats a saved key without a voice as configured but not ready", () => {
    expect(toVoiceStatus({ provider: "elevenlabs", voiceId: "" })).toEqual({
      configured: true,
      ready: false,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "",
    });
  });

  it("is ready once a voice is chosen", () => {
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).ready).toBe(true);
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).transcribe).toBe(false);
  });

  it("is off when nothing is connected", () => {
    expect(toVoiceStatus(null)).toEqual({
      configured: false,
      ready: false,
      transcribe: false,
      provider: null,
      voiceId: "",
    });
  });
});

describe("voice HTTP routes", () => {
  it("rejects unauthenticated speak and transcribe", async () => {
    const app = new Hono();
    mountVoiceHttpRoutes(app, {} as VoiceDeps, async () => null);
    const speak = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const transcribe = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/webm" }),
    });
    expect(speak.status).toBe(401);
    expect(transcribe.status).toBe(401);
  });

  it.each([
    ["/api/voice/speak", MAX_SPEAK_REQUEST_BYTES],
    ["/api/voice/transcribe", MAX_TRANSCRIBE_REQUEST_BYTES],
  ])(
    "rejects a declared oversized body on %s without waiting for cancellation",
    async (path, max) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const app = new Hono();
      mountVoiceHttpRoutes(
        app,
        {} as VoiceDeps,
        async () => ({ userId: "user", spaceId: "space" }) as Actor,
      );

      const response = await app.request(request);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops reading a streamed oversized speak body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SPEAK_REQUEST_BYTES + 1));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {} as VoiceDeps,
      async () => ({ userId: "user", spaceId: "space" }) as Actor,
    );

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

function makeDisconnectDeps(
  overrides: {
    existing?: Array<{ id: string; secretId: string; userId: string; provider: string }>;
    modelReferences?: number;
    voiceReferences?: number;
  } = {},
) {
  const rows = overrides.existing ?? [];
  const findMany = vi.fn().mockResolvedValue(rows);
  const preferenceDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const credentialDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const modelCount = vi.fn().mockResolvedValue(overrides.modelReferences ?? 0);
  const voiceCount = vi.fn().mockResolvedValue(overrides.voiceReferences ?? 0);
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    userVoiceCredential: {
      findMany,
      deleteMany: credentialDeleteMany,
      count: voiceCount,
    },
    spaceVoicePreference: { deleteMany: preferenceDeleteMany },
    userModelCredential: { count: modelCount },
    secret: { deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: { put: vi.fn(), load: vi.fn() },
  } as unknown as VoiceDeps;
  return {
    deps,
    findMany,
    preferenceDeleteMany,
    credentialDeleteMany,
    secretDeleteMany,
    transaction: prisma.$transaction,
  };
}

describe("disconnectVoiceCredential", () => {
  it("removes the actor credential, clears its default, and deletes an unreferenced secret", async () => {
    const existing = {
      id: "cred-1",
      secretId: "secret-1",
      userId: actor.userId,
      provider: "scripted",
    };
    const { deps, findMany, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps({ existing: [existing] });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, provider: "scripted" },
    });
    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-1"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-1"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-1" } });
  });

  it("removes every actor credential for that provider", async () => {
    const { deps, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps({
        existing: [
          {
            id: "cred-new",
            secretId: "secret-new",
            userId: actor.userId,
            provider: "scripted",
          },
          {
            id: "cred-old",
            secretId: "secret-old",
            userId: actor.userId,
            provider: "scripted",
          },
        ],
      });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-new", "cred-old"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-new", "cred-old"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-new" } });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("keeps a secret while another credential still references it", async () => {
    const { deps, credentialDeleteMany, secretDeleteMany } = makeDisconnectDeps({
      existing: [
        {
          id: "cred-1",
          secretId: "secret-shared",
          userId: actor.userId,
          provider: "scripted",
        },
      ],
      voiceReferences: 1,
    });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(credentialDeleteMany).toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("does not delete another actor's credential", async () => {
    const { deps, findMany, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps();

    await expect(
      disconnectVoiceCredential(deps, { ...actor, userId: "intruder" }, { provider: "scripted" }),
    ).resolves.toEqual({ ok: true });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "intruder", provider: "scripted" },
    });
    expect(preferenceDeleteMany).not.toHaveBeenCalled();
    expect(credentialDeleteMany).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects a blank provider before opening a transaction", async () => {
    const { deps, transaction } = makeDisconnectDeps();

    await expect(disconnectVoiceCredential(deps, actor, { provider: "   " })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("fishSpeechModelValue", () => {
  it("trims a Fish model id and treats blank as no override", () => {
    expect(fishSpeechModelValue("  s1  ")).toBe("s1");
    expect(fishSpeechModelValue(" ")).toBeNull();
  });

  it("rejects a model id that cannot be a Fish header", () => {
    expect(() => fishSpeechModelValue("s1\ninjected")).toThrow(
      "That speech model id is not valid.",
    );
  });
});

describe("updateVoiceSpeechModel", () => {
  function speechDeps(preference: { id: string; voiceId: string; isDefault: boolean } | null) {
    const credential = {
      id: "cred-1",
      userId: actor.userId,
      provider: "fish-audio",
      secretId: "secret-1",
    };
    const update = vi
      .fn()
      .mockImplementation(async ({ data }: { data: { speechModel: string | null } }) => ({
        speechModel: data.speechModel,
      }));
    const create = vi.fn();
    const prisma = {
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(credential) },
      spaceVoicePreference: {
        findUnique: vi.fn().mockResolvedValue(preference),
        create,
        update,
        updateMany: vi.fn(),
        upsert: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
    return {
      deps: { prisma, secrets: { put: vi.fn(), load: vi.fn() } } as unknown as VoiceDeps,
      create,
      update,
      updateMany: prisma.spaceVoicePreference.updateMany,
    };
  }

  it("stores the override without changing the selected voice", async () => {
    const { deps, update, updateMany } = speechDeps({
      id: "pref-1",
      voiceId: "voice-1",
      isDefault: false,
    });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " s1 " }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "voice-1",
      speechModel: "s1",
      isDefault: false,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "pref-1" },
      data: { speechModel: "s1" },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("clears the override when the model is blank", async () => {
    const { deps, update } = speechDeps({ id: "pref-1", voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " " }),
    ).resolves.toMatchObject({ speechModel: "" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "pref-1" },
      data: { speechModel: null },
    });
  });

  it("stores a model before a voice is chosen without replacing the default", async () => {
    const { deps, create, update, updateMany } = speechDeps(null);
    create.mockResolvedValue({
      isDefault: false,
      voiceId: "",
      speechModel: "s1",
    });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "",
      speechModel: "s1",
      isDefault: false,
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        credentialId: "cred-1",
        speechModel: "s1",
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects speech models for other providers before writing", async () => {
    const { deps, update } = speechDeps({ id: "pref-1", voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "elevenlabs", speechModel: "s1" }),
    ).rejects.toThrow("Speech model applies to Fish Audio.");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("synthesizeVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the speech model stored on that connection", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: "s1",
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "voice-1",
        apiKey: "fish-key",
        model: "s1",
      }),
      expect.anything(),
    );
  });

  it("omits the model when the connection has no override", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: null,
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ model: undefined });
  });
});

describe("voiceCredentialPlaintext", () => {
  it("keeps a hosted provider's key as the secret and requires one", () => {
    expect(voiceCredentialPlaintext({ provider: "openai", plaintext: "sk-test-key" })).toBe(
      "sk-test-key",
    );
    expect(() => voiceCredentialPlaintext({ provider: "openai", plaintext: "  " })).toThrow(
      "Enter an API key.",
    );
  });

  it("stores a self-hosted server's address and models without a key", () => {
    const plaintext = voiceCredentialPlaintext({
      provider: "openai-compatible",
      plaintext: "",
      baseUrl: "http://100.64.0.10:8810",
      ttsModel: "kokoro",
    });
    expect(JSON.parse(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://100.64.0.10:8810/v1",
      ttsModel: "kokoro",
      sttModel: adapters.DEFAULT_COMPATIBLE_STT_MODEL,
    });
  });

  it("keeps the stored key when reconnecting to the same server with the key left blank", () => {
    const previousPlaintext = adapters.serializeOpenAiCompatibleVoiceSecret({
      baseUrl: "http://100.64.0.10:8810",
      apiKey: "local-test-key",
    });
    const plaintext = voiceCredentialPlaintext({
      provider: "openai-compatible",
      plaintext: "",
      baseUrl: "http://100.64.0.10:8810/v1",
      previousPlaintext,
    });
    expect(JSON.parse(plaintext)).toMatchObject({ apiKey: "local-test-key" });
  });

  it("rejects a public server address as a bad request", () => {
    expect(() =>
      voiceCredentialPlaintext({
        provider: "openai-compatible",
        plaintext: "",
        baseUrl: "https://speech.example.com",
      }),
    ).toThrow(/Public model endpoints are blocked/);
  });
});

describe("voiceCredentialServer", () => {
  const plaintext = adapters.serializeOpenAiCompatibleVoiceSecret({
    baseUrl: "http://100.64.0.10:8810",
    apiKey: "local-test-key",
    ttsModel: "kokoro",
  });

  function deps(
    load: () => string,
    findFirst = vi.fn().mockResolvedValue({ id: "s", ciphertext: "c" }),
  ) {
    return {
      prisma: { secret: { findFirst } },
      secrets: { load: vi.fn(load), put: vi.fn() },
    } as unknown as VoiceDeps;
  }

  it("shows the address and models but never the key", async () => {
    const server = await voiceCredentialServer(
      deps(() => plaintext),
      actor,
      { provider: "openai-compatible", secretId: "secret-1" },
    );
    expect(server).toEqual({
      endpoint: "http://100.64.0.10:8810/v1",
      ttsModel: "kokoro",
      sttModel: adapters.DEFAULT_COMPATIBLE_STT_MODEL,
    });
    const output = toVoiceCredential({
      id: "cred-1",
      provider: "openai-compatible",
      isDefault: true,
      voiceId: "af_heart",
      server,
    });
    expect(JSON.stringify(output)).not.toContain("local-test-key");
    expect(output).not.toHaveProperty("apiKey");
  });

  it("does not decrypt hosted keys and survives an unreadable or unreachable secret", async () => {
    const hosted = deps(() => "sk-test-key");
    expect(
      await voiceCredentialServer(hosted, actor, { provider: "openai", secretId: "secret-1" }),
    ).toBeUndefined();
    expect(hosted.secrets.load).not.toHaveBeenCalled();
    const row = { provider: "openai-compatible", secretId: "secret-1" };
    const broken = deps(() => {
      throw new Error("bad ciphertext");
    });
    expect(await voiceCredentialServer(broken, actor, row)).toBeUndefined();
    const dbDown = deps(() => plaintext, vi.fn().mockRejectedValue(new Error("db down")));
    expect(await voiceCredentialServer(dbDown, actor, row)).toBeUndefined();
  });
});

describe("voiceChoicesChanged", () => {
  const first = adapters.serializeOpenAiCompatibleVoiceSecret({
    baseUrl: "http://100.64.0.10:8810",
  });
  const sameWithKey = adapters.serializeOpenAiCompatibleVoiceSecret({
    baseUrl: "http://100.64.0.10:8810/v1",
    apiKey: "local-test-key",
  });
  const otherModel = adapters.serializeOpenAiCompatibleVoiceSecret({
    baseUrl: "http://100.64.0.10:8810",
    ttsModel: "kokoro",
  });
  const otherServer = adapters.serializeOpenAiCompatibleVoiceSecret({
    baseUrl: "http://100.64.0.11:8880",
  });

  it("drops saved voices only when the server or speech model changes", () => {
    expect(voiceChoicesChanged(undefined, first)).toBe(false);
    expect(voiceChoicesChanged(first, sameWithKey)).toBe(false);
    expect(voiceChoicesChanged(first, otherModel)).toBe(true);
    expect(voiceChoicesChanged(first, otherServer)).toBe(true);
    expect(voiceChoicesChanged("sk-hosted-key", "sk-other-key")).toBe(false);
  });
});

describe("persistVoiceCredential", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      change: "server",
      previous: { baseUrl: "http://100.64.0.10:8810" },
      next: { baseUrl: "http://100.64.0.11:8880" },
    },
    {
      change: "speech model",
      previous: { baseUrl: "http://100.64.0.10:8810", ttsModel: "old-model" },
      next: { baseUrl: "http://100.64.0.10:8810", ttsModel: "new-model" },
    },
  ])(
    "re-picks voices for every space when the self-hosted $change changes",
    async ({ previous: before, next }) => {
      const previous = adapters.serializeOpenAiCompatibleVoiceSecret(before);
      vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
        verify: vi.fn().mockResolvedValue({ ok: true }),
        listVoices: vi.fn().mockResolvedValue([
          { id: "bm_george", label: "George" },
          { id: "af_sky", label: "Sky" },
        ]),
      } as never);
      vi.spyOn(db, "findVoiceCredential").mockResolvedValue({
        id: "cred-1",
        secretId: "old-secret",
        provider: "openai-compatible",
      } as never);
      const select = vi
        .spyOn(db, "selectSpaceVoicePreference")
        .mockResolvedValue(undefined as never);
      vi.spyOn(db, "deleteUnreferencedCredentialSecret").mockResolvedValue(undefined as never);
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      const tx = {
        userVoiceCredential: {
          findFirst: vi.fn().mockResolvedValue({ id: "cred-1", secretId: "old-secret" }),
          update: vi.fn().mockResolvedValue({ id: "cred-1", provider: "openai-compatible" }),
        },
        secret: { create: vi.fn().mockResolvedValue({ id: "new-secret" }) },
        spaceVoicePreference: {
          findUnique: vi.fn().mockResolvedValue({ voiceId: "af_heart", speechModel: null }),
          updateMany,
        },
      };
      const deps = {
        prisma: {
          secret: { findFirst: vi.fn().mockResolvedValue({ id: "old-secret", ciphertext: "c" }) },
          $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)),
        },
        secrets: {
          load: vi.fn().mockReturnValue(previous),
          put: vi.fn().mockResolvedValue({ id: "new-secret", ciphertext: "n" }),
        },
      } as unknown as VoiceDeps;

      const saved = await persistVoiceCredential(deps, actor, {
        provider: "openai-compatible",
        plaintext: "local-test-key",
        voiceId: "af_heart",
        ...next,
      });

      expect(saved.voiceId).toBe("bm_george");
      expect(JSON.stringify(saved)).not.toContain("local-test-key");
      expect(saved).not.toHaveProperty("apiKey");
      expect(saved).not.toHaveProperty("secretId");
      expect(select).toHaveBeenCalledWith(tx, actor, "cred-1", "bm_george", null);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          userId: actor.userId,
          credentialId: "cred-1",
          spaceId: { not: actor.spaceId },
          voiceId: { notIn: ["bm_george", "af_sky"] },
        },
        data: { voiceId: "bm_george" },
      });
    },
  );
});

it.each([
  "http://169.254.169.254",
  "http://169.254.1.2",
  "http://[fd00:ec2::254]",
  "http://[fe80::1]",
  "http://metadata.google.internal",
])("refuses connecting a metadata or link-local speech server: %s", async (baseUrl) => {
  await expect(
    persistVoiceCredential(
      {
        prisma: { userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) } },
      } as unknown as VoiceDeps,
      actor,
      {
        provider: "openai-compatible",
        plaintext: "",
        baseUrl,
      },
    ),
  ).rejects.toThrow(/blocked metadata or link-local/);
});
