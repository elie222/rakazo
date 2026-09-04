import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { listPiCatalog } from "./pi-models.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./pi-oauth.js";
import {
  createOpenAiCompatibleFetch,
  createOpenAiCompatibleLookup,
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  openAiCompatibleCatalogProvider,
  prepareOpenAiCompatibleConnect,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";

describe("model connect", () => {
  it("serializes keyless openai-compatible credentials", () => {
    const plaintext = buildModelConnectPlaintext({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:8000",
      modelId: "qwen3-4b",
    });
    const parsed = parseModelSecret(plaintext);
    expect(parsed).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    expect(secretValuesToRedact(parsed)).toEqual([]);
  });

  it("still requires hosted providers to supply a real API key", () => {
    expect(() => buildModelConnectPlaintext({ provider: "openrouter", apiKey: "short" })).toThrow(
      /at least 8 characters/,
    );
  });

  it("round-trips optional openai-compatible API keys", () => {
    const secret = {
      kind: "openai_compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-secret",
    };
    const parsed = parseModelSecret(serializeModelSecret(secret));
    expect(parsed).toEqual(secret);
    expect(secretValuesToRedact(parsed)).toEqual(["local-secret"]);
  });

  it("keeps private http openai-compatible connects when an API key is set", () => {
    const plaintext = buildModelConnectPlaintext({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:8000",
      modelId: "local-model",
      apiKey: "local-secret",
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-secret",
    });
  });

  it("rejects public http openai-compatible connects when an API key is set", () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      expect(() =>
        prepareOpenAiCompatibleConnect({
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseUrl: "http://api.example.com/v1",
          modelId: "my-model-id",
          apiKey: "secret-key",
        }),
      ).toThrow(/must use HTTPS/);
      expect(() =>
        buildModelConnectPlaintext({
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseUrl: "http://api.example.com/v1",
          modelId: "my-model-id",
          apiKey: "secret-key",
        }),
      ).toThrow(/must use HTTPS/);
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("allows public https openai-compatible connects when an API key is set", () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const prepared = prepareOpenAiCompatibleConnect({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl: "https://api.example.com/v1",
        modelId: "my-model-id",
        apiKey: "secret-key",
      });
      expect(prepared).toEqual({
        baseUrl: "https://api.example.com/v1",
        modelId: "my-model-id",
        apiKey: "secret-key",
      });
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });
});

describe("openai-compatible provider", () => {
  it("does not treat replaced Request Authorization as keyed for public http", async () => {
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const request = new Request("http://api.example.com/v1/models", {
        headers: { Authorization: "Bearer secret" },
      });
      const safeFetch = createOpenAiCompatibleFetch(
        async () => new Response("{}", { status: 200 }),
      );
      await expect(
        safeFetch(request, { headers: { Accept: "application/json" } }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("rejects public hostnames that resolve to private addresses", async () => {
    const lookup = createOpenAiCompatibleLookup(
      new URL("https://models.example.test/v1"),
      async () => [{ address: "127.0.0.1", family: 4 }],
    );
    const error = await new Promise<Error | null>((resolve) => {
      lookup("models.example.test", { family: 0, all: false }, (lookupError) => {
        resolve(lookupError);
      });
    });
    expect(error).toMatchObject({
      message: "Public model server hostname resolved to a private address",
    });
  });

  it("rejects local hostnames that resolve to link-local addresses", async () => {
    const lookup = createOpenAiCompatibleLookup(new URL("http://localhost:8000/v1"), async () => [
      { address: "169.254.1.1", family: 4 },
    ]);
    const error = await new Promise<Error | null>((resolve) => {
      lookup("localhost", { family: 0, all: false }, (lookupError) => resolve(lookupError));
    });
    expect(error).toMatchObject({
      message: "Local model server hostname resolved outside the private network",
    });
  });

  it("always exposes a catalog provider entry", () => {
    const provider = openAiCompatibleCatalogProvider();
    expect(provider.id).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(provider.getModels()[0]?.id).toBe(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  });

  it("registers runtime models at the stored base URL", () => {
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "rapid-mlx",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "rapid-mlx");
    expect(model?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(model?.api).toBe("openai-completions");
  });

  it("probes /v1/models with mocked fetch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
      });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).resolves.toEqual(["a", "b"]);
  });

  it("still accepts legacy models[] probe responses", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ models: [{ id: "legacy" }] }), { status: 200 });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).resolves.toEqual(["legacy"]);
  });

  it("rejects redirect responses during probing", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:9/blocked" },
      });
    };
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/redirect/i);
  });

  it("clarifies non-2xx probe failures with status and hand-fill hint", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/returned 404.*You can still Connect with an explicit model id/s);
  });

  it("clarifies missing models list with hand-fill hint", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ object: "list" }), { status: 200 });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/did not include a models list.*explicit model id/s);
  });

  it("clarifies invalid JSON probe bodies with hand-fill hint", async () => {
    const fetchImpl = async () => new Response("{not-json", { status: 200 });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/invalid JSON.*explicit model id/s);
  });

  it("rejects oversized model lists", async () => {
    const fetchImpl = async () => new Response("x".repeat(64 * 1024 + 1));
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/too large/i);
  });

  it("cancels model responses whose declared size exceeds the limit", async () => {
    let cancelled = false;
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": String(64 * 1024 + 1) } },
      );
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).rejects.toThrow(/too large/i);
    expect(cancelled).toBe(true);
  });

  it("lists openai-compatible in the catalog even without RAKAZO_LOCAL_MODELS", () => {
    delete process.env.RAKAZO_LOCAL_MODELS;
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
