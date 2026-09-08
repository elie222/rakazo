import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  catalogModelLabel,
  listPiCatalog,
  registerAstraModel,
  scriptedCatalogEntry,
} from "./pi-models.js";

describe("Pi model catalog", () => {
  it("keeps the custom catalog independent of server model IDs", () => {
    const custom = listPiCatalog().filter((entry) => entry.provider === "openai-compatible");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ id: "custom", placeholder: true, reasoning: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lists real Pi providers instead of a two-option dropdown", () => {
    const catalog = listPiCatalog();
    const providers = new Set(catalog.map((entry) => entry.provider));
    expect(catalog.length).toBeGreaterThan(20);
    expect(providers.has("openrouter")).toBe(true);
    expect(providers.size).toBeGreaterThan(5);
    expect(
      catalog.some(
        (entry) => entry.auth === "oauth" || entry.auth === "both" || entry.subscription,
      ),
    ).toBe(true);
    const chatgpt = catalog.find((entry) => entry.provider === "openai-codex");
    expect(chatgpt?.signIn).toBe("device-code");
    expect(chatgpt?.billing).toMatch(/ChatGPT Plus or Pro/);
    const copilot = catalog.find((entry) => entry.provider === "github-copilot");
    expect(copilot?.signIn).toBe("device-code");
    const grok = catalog.find((entry) => entry.provider === "xai");
    expect(grok?.signIn).toBe("device-code");
    const claude = catalog.find((entry) => entry.provider === "anthropic");
    expect(claude).toMatchObject({
      signIn: "auth-url",
      authHint: "Claude Pro/Max / key",
      oauthLabel: "Sign in with Claude Pro/Max",
      billing: "",
    });
    expect(scriptedCatalogEntry.provider).toBe("scripted");
  });

  it("lists current xAI and OpenCode Go models from the Pi catalog", () => {
    const catalog = listPiCatalog();
    const ids = (provider: string) =>
      catalog.filter((entry) => entry.provider === provider).map((entry) => entry.id);
    expect(ids("xai")).toContain("grok-4.6");
    expect(ids("opencode-go")).toContain("glm-5.3");
    const grok46 = catalog.find((entry) => entry.provider === "xai" && entry.id === "grok-4.6");
    expect(grok46).toMatchObject({
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
    });
    const openAiCompatible = catalog.find((entry) => entry.provider === "openai-compatible");
    expect(openAiCompatible).toMatchObject({ id: "custom", placeholder: true });
  });

  it("registers Astra with its verified capabilities and exact effort choices", () => {
    const astra = listPiCatalog().find(
      (entry) => entry.provider === "openai-codex" && entry.id === "gpt-6-astra",
    );
    expect(astra).toMatchObject({
      label: "GPT-6 Astra",
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    const models = builtinModels();
    const originalAuth = models.getProvider("openai-codex")?.auth;
    const registered = registerAstraModel(models).getModel("openai-codex", "gpt-6-astra");
    expect(registered).toMatchObject({
      contextWindow: 272_000,
      maxTokens: 32_768,
      input: ["text", "image"],
    });
    expect(models.getProvider("openai-codex")?.auth).toBe(originalAuth);
  });

  it("sends Astra ultra unchanged in the OpenAI Codex request body", async () => {
    let payload: { reasoning?: { effort?: string } } | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ error: { message: "fixture stop" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const token = `e30.${Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }),
    ).toString("base64url")}.fixture`;
    const models = registerAstraModel(builtinModels());
    const model = models.getModel("openai-codex", "gpt-6-astra");
    expect(model).toBeDefined();
    const stream = streamCodex(
      model!,
      {
        systemPrompt: "Test fixture.",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [],
      },
      {
        apiKey: token,
        reasoningEffort: "ultra",
        transport: "sse",
        fetch,
        onPayload: (body: typeof payload) => {
          payload = body;
        },
      } as never,
    );
    for await (const _event of stream) {
      // Exhaust the stream so the adapter constructs and sends its request.
    }
    expect(payload).toMatchObject({ reasoning: { effort: "ultra" } });
  });

  it("adds a configured OpenRouter model that is newer than the static catalog", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
    vi.stubEnv("PI_DEFAULT_MODEL", " rakazo-test/unknown-future-model ");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "rakazo-test/unknown-future-model",
      label: "rakazo-test/unknown-future-model",
    });
  });

  it("normalizes a PI_DEFAULT_MODEL id that ends in -latest", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("PI_DEFAULT_MODEL", "foo-latest");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(listConfiguredCatalog()[0]).toMatchObject({
      provider: "openrouter",
      id: "foo-latest",
      label: "foo (auto-updates)",
    });
  });

  it("does not advertise a synthetic model for providers the runtime cannot synthesize", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "anthropic");
    vi.stubEnv("PI_DEFAULT_MODEL", "future/unknown-model");
    vi.resetModules();

    const { listPiCatalog: listConfiguredCatalog } = await import("./pi-models.js");
    expect(
      listConfiguredCatalog().some(
        (entry) => entry.provider === "anthropic" && entry.id === "future/unknown-model",
      ),
    ).toBe(false);
  });

  it('never labels an older model "latest" and keeps aliases distinct from snapshots', () => {
    const catalog = listPiCatalog();
    const label = (id: string) =>
      catalog.find((entry) => entry.provider === "anthropic" && entry.id === id)?.label;
    expect(label("claude-opus-5")).toBeDefined();
    expect(label("claude-opus-4-5")).toBe("Claude Opus 4.5 (auto-updates)");
    expect(label("claude-haiku-4-5")).toBe("Claude Haiku 4.5 (auto-updates)");
    expect(label("claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(catalog.some((entry) => /\blatest\b/i.test(entry.label))).toBe(false);
  });
});

describe("catalogModelLabel", () => {
  const providerModelIds = [
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "mistral-medium",
    "mistral-medium-2508",
    "mistral-small",
    "mistral-small-260401",
    "foo",
    "foo-preview",
  ];

  it.each([
    // Alias: the id ends in `latest`, or a dated sibling proves the undated id floats.
    ["claude-opus-4-5", "Claude Opus 4.5 (latest)", "Claude Opus 4.5 (auto-updates)"],
    ["mistral-medium", "Mistral Medium Latest", "Mistral Medium (auto-updates)"],
    ["mistral-small", "Mistral Small Latest", "Mistral Small (auto-updates)"],
    ["gemini-flash-latest", "Gemini Flash Latest", "Gemini Flash (auto-updates)"],
    ["foo-latest", "foo-latest", "foo (auto-updates)"],
    ["foo/latest", "foo/latest", "foo (auto-updates)"],
    // Pinned: `-preview` is its own model and a dated id is already a snapshot, so promise nothing.
    ["foo", "Foo Latest", "Foo"],
    ["claude-opus-4-5-20251101", "Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
    // Untouched: no marker, no name, or nothing left once the marker goes.
    ["claude-opus-5", "Claude Opus 5", "Claude Opus 5"],
    ["some-model", undefined, "some-model"],
    ["latest", "latest", "latest"],
  ])("labels %s / %s as %s", (id, name, expected) => {
    expect(catalogModelLabel(id, name, providerModelIds)).toBe(expected);
  });
});
