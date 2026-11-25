import { VoiceAccountError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import * as db from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import {
  mountVoiceHttpRoutes,
  persistVoiceCredential,
  synthesizeVoice,
  withVoiceConnection,
} from "./voice.js";
import { accountVoiceCatalog, voiceCredentialLink } from "./voice-model-connection.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

const xaiModelCredential = {
  id: "model-cred-1",
  userId: actor.userId,
  provider: "xai",
  label: "xAI",
  secretId: "model-secret",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** The account's model connections and stored secrets, keyed by secret id. */
function modelConnectionDeps(
  plaintexts: Record<string, string>,
  prisma: Record<string, unknown> = {},
  modelCredentials = [xaiModelCredential],
) {
  type Where = { id?: string; provider?: string | { in: string[] } };
  const matches = (row: typeof xaiModelCredential, where: Where = {}) =>
    (!where.id || row.id === where.id) &&
    (!where.provider ||
      (typeof where.provider === "string"
        ? row.provider === where.provider
        : where.provider.in.includes(row.provider)));
  return {
    prisma: {
      userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
      userModelCredential: {
        findMany: vi.fn(async ({ where }: { where?: Where } = {}) =>
          modelCredentials.filter((row) => matches(row, where)),
        ),
        findFirst: vi.fn(async ({ where }: { where?: Where } = {}) => {
          const row = modelCredentials.find((credential) => matches(credential, where));
          return row ? { ...row, userPreferences: [] } : null;
        }),
      },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id in plaintexts ? { id: where.id, ciphertext: `cipher:${where.id}` } : null,
        ),
      },
      ...prisma,
    },
    secrets: {
      load: vi.fn((ciphertext: string) => plaintexts[ciphertext.replace(/^cipher:/, "")]),
      put: vi.fn().mockResolvedValue({ id: "voice-secret", ciphertext: "cipher:voice-secret" }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("synthesizeVoice through a model connection", () => {
  const linkedPreference = {
    isDefault: true,
    voiceId: "eve",
    speechModel: null,
    credential: {
      id: "cred-1",
      userId: actor.userId,
      provider: "xai",
      secretId: "voice-secret",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
  const voicePrisma = {
    spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
    userVoicePreference: { findFirst: vi.fn().mockResolvedValue(linkedPreference) },
  };

  it("speaks with the model connection's key", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const deps = modelConnectionDeps(
      {
        "voice-secret": adapters.modelConnectionVoiceSecret(),
        "model-secret": "xai-model-key",
      },
      voicePrisma,
    ) as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "xai-model-key",
      voiceId: "eve",
    });
  });

  it("speaks with the model connection it was linked to, not the newest one", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const newest = { ...xaiModelCredential, id: "model-cred-new", secretId: "model-secret-new" };
    const linked = { ...xaiModelCredential, id: "model-cred-old", secretId: "model-secret-old" };
    const deps = modelConnectionDeps(
      {
        "voice-secret": adapters.modelConnectionVoiceSecret("model-cred-old"),
        "model-secret-new": "xai-newest-key",
        "model-secret-old": "xai-linked-key",
      },
      voicePrisma,
      [newest, linked],
    ) as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ apiKey: "xai-linked-key" });
  });

  it("asks to reconnect the model provider once that connection is gone", async () => {
    const synthesize = vi.fn();
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const deps = modelConnectionDeps(
      { "voice-secret": adapters.modelConnectionVoiceSecret() },
      voicePrisma,
      [],
    ) as unknown as VoiceDeps;
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);

    const response = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Connect xAI in Models settings.",
    });
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("voiceCredentialLink", () => {
  const linked = { provider: "xai", secretId: "voice-secret" };
  const depsWith = (plaintexts: Record<string, string>) => {
    const deps = modelConnectionDeps(plaintexts);
    return { deps: deps as unknown as VoiceDeps, load: deps.secrets.load, raw: deps };
  };

  it("tells a key from a link, and names the model connection a link uses", async () => {
    const named = depsWith({ "voice-secret": adapters.modelConnectionVoiceSecret("model-1") });
    expect(await voiceCredentialLink(named.deps, actor, linked)).toEqual({
      hasKey: false,
      modelCredentialId: "model-1",
    });
    const unnamed = depsWith({ "voice-secret": adapters.modelConnectionVoiceSecret() });
    expect(await voiceCredentialLink(unnamed.deps, actor, linked)).toEqual({
      hasKey: false,
      modelCredentialId: undefined,
    });
    const keyed = depsWith({ "voice-secret": "xai-test-key" });
    expect(await voiceCredentialLink(keyed.deps, actor, linked)).toEqual({ hasKey: true });
  });

  it("does not decrypt other providers' keys and counts an unreadable secret as a key", async () => {
    const hosted = depsWith({ "voice-secret": adapters.modelConnectionVoiceSecret() });
    expect(
      await voiceCredentialLink(hosted.deps, actor, {
        provider: "openai",
        secretId: "voice-secret",
      }),
    ).toEqual({ hasKey: true });
    expect(hosted.load).not.toHaveBeenCalled();

    const broken = depsWith({ "voice-secret": adapters.modelConnectionVoiceSecret() });
    broken.load.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    expect(await voiceCredentialLink(broken.deps, actor, linked)).toEqual({ hasKey: true });
    const missing = depsWith({});
    expect(await voiceCredentialLink(missing.deps, actor, linked)).toEqual({ hasKey: true });
  });

  it("lets the credentials read report a database failure", async () => {
    const { deps, raw } = depsWith({});
    const outage = new Error("database unavailable");
    raw.prisma.secret.findFirst.mockRejectedValue(outage);
    await expect(voiceCredentialLink(deps, actor, linked)).rejects.toBe(outage);
  });
});

describe("accountVoiceCatalog", () => {
  async function catalogFor(modelCredentials: Array<typeof xaiModelCredential>) {
    const deps = modelConnectionDeps({}, {}, modelCredentials) as unknown as VoiceDeps;
    return accountVoiceCatalog(deps, actor);
  }

  it("lists each of the account's model connections a provider can use for voice", async () => {
    const second = { ...xaiModelCredential, id: "model-cred-2", label: "xAI 2" };
    const catalog = await catalogFor([xaiModelCredential, second]);
    expect(catalog.find((entry) => entry.id === "xai")).toMatchObject({
      modelConnection: true,
      modelConnections: [
        { id: "model-cred-1", label: "xAI" },
        { id: "model-cred-2", label: "xAI 2" },
      ],
    });
    expect(catalog.find((entry) => entry.id === "xai")).not.toHaveProperty("modelSignIn");
    expect(catalog.filter((entry) => entry.modelConnections)).toHaveLength(1);
  });

  it("names each connection as Models does", async () => {
    const catalog = await catalogFor([
      { ...xaiModelCredential, id: "unnamed", label: "xai" },
      { ...xaiModelCredential, id: "blank", label: " " },
      { ...xaiModelCredential, id: "email", label: "me@example.test" },
    ]);
    expect(catalog.find((entry) => entry.id === "xai")?.modelConnections).toEqual([
      { id: "unnamed", label: "xAI" },
      { id: "blank", label: "xAI" },
      { id: "email", label: "xAI (me@example.test)" },
    ]);
  });

  it("offers the Models sign-in when the account has no connection voice can use", async () => {
    for (const credentials of [[], [{ ...xaiModelCredential, provider: "openai" }]]) {
      const xai = (await catalogFor(credentials)).find((entry) => entry.id === "xai");
      expect(xai).not.toHaveProperty("modelConnections");
      expect(xai).not.toHaveProperty("modelConnection");
      expect(xai?.modelSignIn).toBe(
        adapters.listPiCatalog().find((model) => model.provider === "xai" && model.signIn)
          ?.oauthLabel,
      );
      expect(xai?.modelSignIn).toBeTruthy();
    }
    const others = (await catalogFor([])).filter((entry) => entry.id !== "xai");
    expect(others.some((entry) => entry.modelSignIn || entry.modelConnections)).toBe(false);
  });

  it("offers neither connections nor a sign-in for a model provider the deployment refuses", async () => {
    vi.stubEnv("RAKAZO_MODEL_PROVIDER_ALLOWLIST", "openrouter");
    for (const credentials of [[], [xaiModelCredential]]) {
      const xai = (await catalogFor(credentials)).find((entry) => entry.id === "xai");
      expect(xai).toBeDefined();
      expect(xai).not.toHaveProperty("modelConnections");
      expect(xai).not.toHaveProperty("modelSignIn");
    }
  });
});

describe("persistVoiceCredential through a model connection", () => {
  function linkedDeps(
    modelCredentials = [xaiModelCredential],
    plaintexts: Record<string, string> = { "model-secret": "xai-model-key" },
  ) {
    const tx = {
      userVoiceCredential: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "cred-1", provider: "xai" }),
      },
      secret: { create: vi.fn().mockResolvedValue({ id: "voice-secret" }) },
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    };
    const deps = modelConnectionDeps(
      plaintexts,
      { $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)) },
      modelCredentials,
    );
    return { deps: deps as unknown as VoiceDeps, put: deps.secrets.put };
  }

  function stubProvider() {
    const verify = vi.fn().mockResolvedValue({ ok: true });
    const listVoices = vi.fn().mockResolvedValue([{ id: "eve", label: "Eve" }]);
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ verify, listVoices } as never);
    vi.spyOn(db, "selectVoicePreference").mockResolvedValue(undefined as never);
    return { verify, listVoices };
  }

  it("checks a blank key against the model connection but stores only the link", async () => {
    const { verify, listVoices } = stubProvider();
    const { deps, put } = linkedDeps();

    const saved = await persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" });

    expect(verify).toHaveBeenCalledWith("xai-model-key", expect.anything());
    expect(listVoices).toHaveBeenCalledWith("xai-model-key", expect.anything(), {});
    expect(put).toHaveBeenCalledWith(adapters.modelConnectionVoiceSecret(), expect.anything());
    expect(JSON.stringify(put.mock.calls)).not.toContain("xai-model-key");
    expect(saved).toMatchObject({ provider: "xai", hasKey: false, voiceId: "eve" });
  });

  it("lists the voices of the speech model it is connected with", async () => {
    const { listVoices } = stubProvider();
    const input = { provider: "openrouter", plaintext: "or-key-123", speechModel: "a/b" };
    await persistVoiceCredential(linkedDeps().deps, actor, input);
    expect(listVoices).toHaveBeenCalledWith("or-key-123", expect.anything(), { model: "a/b" });
  });

  it("links the model connection the user chose and checks it with that one's key", async () => {
    const { verify } = stubProvider();
    const chosen = { ...xaiModelCredential, id: "model-cred-2", secretId: "model-secret-2" };
    const { deps, put } = linkedDeps([xaiModelCredential, chosen], {
      "model-secret": "xai-model-key",
      "model-secret-2": "xai-second-key",
    });

    const saved = await persistVoiceCredential(deps, actor, {
      provider: "xai",
      plaintext: "",
      modelCredentialId: "model-cred-2",
    });

    expect(verify).toHaveBeenCalledWith("xai-second-key", expect.anything());
    expect(put).toHaveBeenCalledWith(
      adapters.modelConnectionVoiceSecret("model-cred-2"),
      expect.anything(),
    );
    expect(saved).toMatchObject({ hasKey: false, modelCredentialId: "model-cred-2" });
  });

  it("refuses a model connection that is not the account's connection to that provider", async () => {
    const { verify } = stubProvider();
    const { deps, put } = linkedDeps([
      xaiModelCredential,
      { ...xaiModelCredential, id: "openai-cred", provider: "openai" },
    ]);

    for (const modelCredentialId of ["openai-cred", "someone-elses"]) {
      await expect(
        persistVoiceCredential(deps, actor, {
          provider: "xai",
          plaintext: "",
          modelCredentialId,
        }),
      ).rejects.toMatchObject({ message: "Connect xAI in Models settings." });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("uses a key the user enters instead of the model connection", async () => {
    const { verify } = stubProvider();
    const { deps, put } = linkedDeps();

    const saved = await persistVoiceCredential(deps, actor, {
      provider: "xai",
      plaintext: "xai-own-key",
    });

    expect(verify).toHaveBeenCalledWith("xai-own-key", expect.anything());
    expect(put).toHaveBeenCalledWith("xai-own-key", expect.anything());
    expect(saved.hasKey).toBe(true);
  });

  it("asks to connect the model provider first when there is no model connection", async () => {
    const { verify } = stubProvider();
    const { deps, put } = linkedDeps([]);

    await expect(
      persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Connect xAI in Models settings." });
    expect(verify).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("explains a model connection that fails to refresh instead of failing silently", async () => {
    const { verify } = stubProvider();
    const { deps, put } = linkedDeps();
    vi.spyOn(adapters, "resolveVoiceKey").mockRejectedValueOnce(new Error("refresh timed out"));

    await expect(
      persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Couldn't use the xAI connection from Models. Try again.",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("asks for a key when xAI refuses the model connection, not to check a key never typed", async () => {
    const { verify } = stubProvider();
    verify.mockResolvedValueOnce({
      ok: false,
      message: "xAI rejected that key.",
      code: "VOICE_KEY_REJECTED",
    });
    const { deps, put } = linkedDeps();

    await expect(
      persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
    ).rejects.toMatchObject({
      message: "xAI didn't accept the Models connection for voice. Paste an API key.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "spent credit",
      message: "You have run out of credits or need a Grok subscription",
      code: "VOICE_OUT_OF_CREDIT" as const,
    },
    { name: "a rate limit", message: "xAI is rate-limiting this account." },
    { name: "an outage", message: "checking that key failed (503)" },
  ])("keeps xAI's own words for $name", async ({ message, code }) => {
    const { verify } = stubProvider();
    verify.mockResolvedValueOnce({ ok: false, message, code });
    const { deps } = linkedDeps();

    await expect(
      persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
    ).rejects.toMatchObject({ message });
  });
});

describe("linked voice failures", () => {
  it("hides refresh and provider response text", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", level: "warn", sinks: [sink] }));
    try {
      await expect(
        withVoiceConnection("xai", true, async () => {
          throw new Error("private provider response");
        }),
      ).rejects.toThrow("Couldn't use the xAI connection from Models. Try again.");
      expect(JSON.stringify(sink.events)).not.toContain("private provider response");
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("offers disconnect and a key when a linked bearer is rejected", async () => {
    await expect(
      withVoiceConnection("xai", true, async () => {
        throw new VoiceAccountError("VOICE_KEY_REJECTED", "check the key");
      }),
    ).rejects.toMatchObject({
      code: "VOICE_KEY_REJECTED",
      message:
        "xAI didn't accept the Models connection for voice. Disconnect and paste an API key.",
    });
  });
});
