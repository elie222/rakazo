import { afterEach, describe, expect, it, vi } from "vitest";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";

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
});
