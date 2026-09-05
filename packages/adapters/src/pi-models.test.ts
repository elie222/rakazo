import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogModelLabel, listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";

describe("Pi model catalog", () => {
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
