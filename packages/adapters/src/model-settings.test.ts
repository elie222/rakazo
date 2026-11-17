import { credentialModelSettings, modelSettingsFields, modelSettingsRequest } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import {
  persistRefreshedModelCredential,
  retireToReconnectMarker,
} from "./model-credential-refresh.js";
import { keptModelSettings, parseModelSecret, serializeModelSecret } from "./model-secret.js";
import { withLiveModelSettings } from "./model-selection.js";
import { connectionModelSettings, withModelSettings } from "./model-settings.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { liveCatalogEntry } from "./pi-live-catalog.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

// A model the Z.AI provider lists but the bundled catalog does not describe.
const LISTED_ONLY = "glm-5.3-flashx";
const KEY = "sk-synthetic-key";
const oauth = { type: "oauth" as const, access: "access", refresh: "refresh", expires: 1 };

describe("stored model settings", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "preserves settings for the model named %s",
    (modelId) => {
      const configured = withModelSettings(
        parseModelSecret(
          JSON.stringify({ kind: "openai_compatible", baseUrl: "https://models.example.test/v1" }),
        ),
        modelId,
        { images: true, reasoning: true, maxTokens: 2000 },
      );
      const saved = parseModelSecret(serializeModelSecret(configured));
      expect(Object.hasOwn(saved.models!, modelId)).toBe(true);
      expect(saved.models?.[modelId]).toEqual({
        images: true,
        reasoning: true,
        maxTokens: 2000,
      });
      expect(connectionModelSettings(saved, "openai-compatible", modelId)).toEqual(
        saved.models?.[modelId],
      );
      expect(
        credentialModelSettings(
          { provider: "openai-compatible", modelSettings: saved.models },
          modelId,
        ),
      ).toEqual(saved.models?.[modelId]);
    },
  );

  it("keep each model's settings through a round trip, dropping invalid ones", () => {
    const stored = parseModelSecret(
      JSON.stringify({
        kind: "api_key",
        key: KEY,
        models: {
          [LISTED_ONLY]: { images: true, maxTokens: 8_000 },
          broken: { maxTokens: 10, contextWindow: 5 },
          empty: {},
        },
      }),
    );
    expect(stored.models).toEqual({
      [LISTED_ONLY]: { images: true, maxTokens: 8_000 },
      empty: {},
    });
    expect(parseModelSecret(serializeModelSecret(stored))).toEqual(stored);
  });

  it("keep a plain key plain until a model has settings", () => {
    const secret = parseModelSecret(KEY);
    expect(serializeModelSecret(secret)).toBe(KEY);
    const withSettings = withModelSettings(secret, LISTED_ONLY, { images: true });
    expect(JSON.parse(serializeModelSecret(withSettings))).toMatchObject({
      kind: "api_key",
      key: KEY,
      models: { [LISTED_ONLY]: { images: true } },
    });
    expect(serializeModelSecret(withModelSettings(withSettings, LISTED_ONLY, {}))).toBe(KEY);
  });

  it("survive a sign-in refresh, retirement or replacement", () => {
    const signedIn = withModelSettings(parseModelSecret(JSON.stringify(oauth)), LISTED_ONLY, {
      reasoning: true,
    });
    const kept = keptModelSettings(signedIn);
    expect(kept).toEqual({ models: { [LISTED_ONLY]: { reasoning: true } } });
    for (const next of [
      { kind: "oauth" as const, credential: { ...oauth, access: "rotated" }, ...kept },
      { kind: "oauth" as const, reconnectRequired: true as const, ...kept },
    ])
      expect(parseModelSecret(serializeModelSecret(next)).models).toEqual(kept.models);
  });

  it("keeps selected models' settings across a URL change without forwarding credentials", () => {
    const previous = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://models.example.test/old",
      apiKey: "fake-old-api-key",
      headers: { "x-private": "fake-private-value" },
      reasoning: true,
      enabledModelIds: ["kept", "removed"],
      models: {
        kept: { images: true, reasoning: false, contextWindow: 32000, maxTokens: 2000 },
        removed: { images: false },
      },
    });
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        {
          provider: "openai-compatible",
          baseUrl: "https://models.example.test/new",
          modelId: "kept",
        },
        previous,
      ),
    );
    expect(saved.models).toEqual({
      kept: { images: true, reasoning: false, contextWindow: 32000, maxTokens: 2000 },
    });
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("headers");
    expect(saved).not.toHaveProperty("reasoning");
  });

  it("survive a key replacement and an endpoint save on the same server", () => {
    const keyed = serializeModelSecret(
      withModelSettings(parseModelSecret(KEY), LISTED_ONLY, { images: true }),
    );
    const replaced = buildModelConnectPlaintext(
      { provider: "zai", apiKey: "sk-another-key" },
      keyed,
    );
    expect(parseModelSecret(replaced).models).toEqual({ [LISTED_ONLY]: { images: true } });

    const endpoint = serializeModelSecret(
      withModelSettings(
        parseModelSecret(
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://models.example.test/v1",
            apiKey: KEY,
            reasoning: true,
          }),
        ),
        "served",
        { images: true },
      ),
    );
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        {
          provider: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          modelId: "served",
        },
        endpoint,
      ),
    );
    expect(saved).toMatchObject({ reasoning: true, models: { served: { images: true } } });
  });
});

describe("a token a run refreshed", () => {
  function store(plaintext: string) {
    let current = plaintext;
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      secret: {
        findFirst: vi.fn(async () => ({ ciphertext: "sealed" })),
        update: vi.fn(async () => ({})),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      secret: tx.secret,
    };
    const secrets = {
      load: vi.fn(async () => current),
      put: vi.fn(async (next: string) => {
        current = next;
        return { id: "secret-1", ciphertext: "sealed-again" };
      }),
    };
    const persist = persistRefreshedModelCredential(
      prisma as never,
      secrets as never,
      { userId: "user-1", spaceId: "space-1" },
      "secret-1",
    );
    return { persist, tx, stored: () => parseModelSecret(current) };
  }

  it("is saved under the settings lock onto the stored copy, keeping its model settings", async () => {
    const { persist, tx, stored } = store(
      serializeModelSecret(
        withModelSettings(parseModelSecret(JSON.stringify(oauth)), LISTED_ONLY, { images: true }),
      ),
    );
    await persist({ type: "oauth", access: "rotated", refresh: "refresh-2", expires: 2 });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(stored()).toMatchObject({
      kind: "oauth",
      credential: { access: "rotated", expires: 2 },
      models: { [LISTED_ONLY]: { images: true } },
    });
  });

  it("leaves a newer stored token alone", async () => {
    const { persist, tx } = store(JSON.stringify({ ...oauth, expires: 10 }));
    await persist({ type: "oauth", access: "older", refresh: "refresh", expires: 5 });
    expect(tx.secret.update).not.toHaveBeenCalled();
  });
});

describe("retiring a rejected sign-in", () => {
  it("keeps settings saved while it was retiring", async () => {
    const plaintexts = new Map<string, string>();
    const signedIn = (settings: object) =>
      serializeModelSecret(
        withModelSettings(parseModelSecret(JSON.stringify(oauth)), LISTED_ONLY, settings),
      );
    plaintexts.set("first", signedIn({ images: true }));
    const row = { id: "secret-1", ciphertext: "first" };
    let puts = 0;
    const secretStore = {
      load: vi.fn(async (ciphertext: string) => plaintexts.get(ciphertext)!),
      put: vi.fn(async (plaintext: string) => {
        puts += 1;
        // A settings save lands after the first attempt read the stored copy.
        if (puts === 1) {
          plaintexts.set("saved", signedIn({ images: true, reasoning: true }));
          row.ciphertext = "saved";
        }
        const ciphertext = `marker-${puts}`;
        plaintexts.set(ciphertext, plaintext);
        return { id: "secret-1", ciphertext };
      }),
      delete: vi.fn(async () => undefined),
    };
    const client = {
      userModelCredential: {
        findFirst: vi.fn(async () => ({ id: "credential-1", secretId: "secret-1" })),
      },
      secret: {
        findFirst: vi.fn(async () => ({ ...row })),
        update: vi.fn(async ({ data }: { data: { ciphertext: string } }) => {
          row.ciphertext = data.ciphertext;
        }),
      },
    };
    const prisma = {
      ...client,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
    };
    const retire = retireToReconnectMarker(
      prisma as never,
      secretStore as never,
      { userId: "user-1", spaceId: "space-1" },
      { id: "credential-1", secretId: "secret-1" },
    );
    expect(await retire("refresh_rejected" as never, undefined)).toBe(true);
    expect(parseModelSecret(plaintexts.get(row.ciphertext)!)).toMatchObject({
      kind: "oauth",
      reconnectRequired: true,
      models: { [LISTED_ONLY]: { images: true, reasoning: true } },
    });
  });
});

describe("saving an OpenAI-compatible connection", () => {
  it("drops the settings of models it no longer serves and no longer keeps its old effort", () => {
    const stored = serializeModelSecret(
      withModelSettings(
        withModelSettings(
          parseModelSecret(
            JSON.stringify({
              kind: "openai_compatible",
              baseUrl: "https://models.example.test/v1",
              enabledModelIds: ["kept", "removed"],
              thinkingLevel: "high",
            }),
          ),
          "kept",
          { images: true },
        ),
        "removed",
        { reasoning: true },
      ),
    );
    const saved = parseModelSecret(
      buildModelConnectPlaintext(
        {
          provider: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          modelId: "kept",
          enabledModelIds: [],
        },
        stored,
      ),
    );
    expect(saved.models).toEqual({ kept: { images: true } });
    expect(saved).not.toHaveProperty("thinkingLevel");
  });
});

describe("connectionModelSettings", () => {
  it("returns a cleared model to its card, not to the connection's earlier values", () => {
    const legacy = parseModelSecret(
      JSON.stringify({ kind: "api_key", key: KEY, maxTokens: 2_048 }),
    );
    const cleared = withModelSettings(
      withModelSettings(legacy, "glm-5.3", { maxTokens: 4_000 }),
      "glm-5.3",
      {},
    );
    expect(connectionModelSettings(cleared, "zai", "glm-5.3")).toEqual({});
    expect(connectionModelSettings(cleared, "zai", "glm-5.3-flash")).toEqual({ maxTokens: 2_048 });
    expect(parseModelSecret(serializeModelSecret(cleared)).models).toEqual({ "glm-5.3": {} });
  });

  it("prefers a model's own settings over the connection's earlier values", () => {
    const secret = withModelSettings(
      parseModelSecret(JSON.stringify({ kind: "api_key", key: KEY, maxTokens: 2_048 })),
      LISTED_ONLY,
      { images: true },
    );
    expect(connectionModelSettings(secret, "zai", LISTED_ONLY)).toEqual({ images: true });
    expect(connectionModelSettings(secret, "zai", "glm-5.3")).toEqual({ maxTokens: 2_048 });
  });

  it("keeps the catalog's image and thinking answer for models it knows", () => {
    const secret = withModelSettings(parseModelSecret(KEY), "glm-5.3", {
      images: true,
      reasoning: false,
      maxTokens: 4_000,
    });
    expect(connectionModelSettings(secret, "zai", "glm-5.3")).toEqual({ maxTokens: 4_000 });
  });

  it("reads an OpenAI-compatible connection's earlier settings for each model", () => {
    const secret = parseModelSecret(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://models.example.test/v1",
        reasoning: true,
        visionModelIds: ["vision"],
        maxImagesPerPrompt: 3,
        contextWindow: 64_000,
      }),
    );
    expect(connectionModelSettings(secret, "openai-compatible", "vision")).toEqual({
      contextWindow: 64_000,
      reasoning: true,
      images: true,
      maxImagesPerPrompt: 3,
    });
    expect(connectionModelSettings(secret, "openai-compatible", "text").images).toBeUndefined();
  });

  it("shows each model's settings and image support on the connection the apps read", () => {
    const plaintext = serializeModelSecret(
      withModelSettings(
        parseModelSecret(
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://models.example.test/v1",
            enabledModelIds: ["vision", "text"],
          }),
        ),
        "vision",
        { images: true, reasoning: true },
      ),
    );
    const dto = modelCredentialDto(
      { id: "c", provider: "openai-compatible", label: "Server", defaultModel: "vision" },
      plaintext,
    );
    expect(dto.modelSettings).toEqual({ vision: { images: true, reasoning: true } });
    expect(dto.visionModelIds).toEqual(["vision"]);
    expect(dto.thinkingLevels?.length).toBeGreaterThan(1);
  });
});

describe("listed-only models", () => {
  it("read images and think as their settings say, at runtime and in the catalog", () => {
    const unset = resolveRuntimeModel({ provider: "zai", id: LISTED_ONLY }).model;
    expect(unset?.input).toEqual(["text"]);
    const set = resolveRuntimeModel({
      provider: "zai",
      id: LISTED_ONLY,
      acceptsImages: true,
      reasoning: true,
    }).model;
    expect(set).toMatchObject({ input: ["text", "image"], reasoning: true });

    expect(liveCatalogEntry("zai", LISTED_ONLY)).toMatchObject({
      images: false,
      thinkingLevels: ["off"],
    });
    const entry = liveCatalogEntry("zai", LISTED_ONLY, { images: true, reasoning: true });
    expect(entry).toMatchObject({ images: true, reasoning: true });
    expect(entry?.thinkingLevels?.length).toBeGreaterThan(1);
  });

  it("show the serving connection's settings in the catalog, but never over an account's answer", () => {
    const listed = liveCatalogEntry("zai", LISTED_ONLY)!;
    const account = { ...listed, provider: "openai-codex", images: false };
    const auth = {
      secretIdByProvider: { zai: "secret-zai", "openai-codex": "secret-codex" },
      secretIdByModel: {},
      modelSettingsBySecretId: {
        "secret-zai": { [LISTED_ONLY]: { images: true } },
        "secret-codex": { [LISTED_ONLY]: { images: true } },
      },
    };
    const [zai, codex] = withLiveModelSettings(auth, [listed, account]);
    expect(zai?.images).toBe(true);
    expect(zai?.defaultCapabilities).toMatchObject({
      images: listed.images,
      reasoning: listed.reasoning,
    });
    expect(zai?.defaultCapabilities?.thinkingLevels?.length).toBeGreaterThan(1);
    expect(codex).toBe(account);
  });

  it("follow their setting for image input while known models follow the catalog", () => {
    expect(modelAcceptsImageInput("zai", LISTED_ONLY)).toBe(false);
    expect(modelAcceptsImageInput("zai", LISTED_ONLY, true)).toBe(true);
    expect(modelAcceptsImageInput("zai", "glm-5.3", true)).toBe(false);
    expect(modelAcceptsImageInput("zai", "glm-5.3-flash", false)).toBe(true);
  });
});

it("keeps legacy image settings aligned between runtime and the credential DTO", () => {
  const row = {
    id: "fixture",
    provider: "openai-compatible",
    label: "Fixture",
    defaultModel: "served",
    supportsImages: true,
  };
  const secret = {
    kind: "openai_compatible" as const,
    apiKey: "fake-key",
    baseUrl: "https://example.com/v1",
  };
  const dto = modelCredentialDto(row, serializeModelSecret(secret));
  for (const modelId of ["served", "other"]) {
    expect(credentialModelSettings(dto, modelId).images).toBe(
      connectionModelSettings(secret, row.provider, modelId, row).images,
    );
  }
});

it("preserves operator-enabled image input when saving a model's limits", () => {
  vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "operator-vision-fixture");
  try {
    const modelId = "operator-vision-fixture";
    const row = {
      id: "fixture",
      provider: "openai-compatible",
      label: "Fixture",
      defaultModel: modelId,
    };
    const secret = parseModelSecret(
      JSON.stringify({ kind: "openai_compatible", baseUrl: "https://example.com/v1" }),
    );
    const dto = modelCredentialDto(row, serializeModelSecret(secret));
    const fields = modelSettingsFields(credentialModelSettings(dto, modelId), undefined);
    expect(fields.images).toBe(true);
    expect(
      modelSettingsRequest({
        fields: { ...fields, maxTokens: "2000" },
        provider: row.provider,
        entry: undefined,
      }),
    ).toMatchObject({ status: "ready", settings: { images: true, maxTokens: 2000 } });
    const disabled = modelCredentialDto(
      row,
      serializeModelSecret(withModelSettings(secret, modelId, { images: false })),
    );
    expect(modelSettingsFields(credentialModelSettings(disabled, modelId), undefined).images).toBe(
      false,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
