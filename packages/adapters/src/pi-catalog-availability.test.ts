import { describe, expect, it } from "vitest";
import {
  catalogModelAvailableForAuth,
  listAvailablePiCatalog,
  modelCredentialAuthKindFromPlaintext,
  OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS,
} from "./pi-catalog-availability.js";
import { listPiCatalog } from "./pi-models.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";

describe("openai-codex catalog availability", () => {
  const spark = "gpt-5.3-codex-spark";

  it("excludes Codex Spark for ChatGPT subscription sign-in", () => {
    expect(OPENAI_CODEX_CHATGPT_SUBSCRIPTION_EXCLUDED_MODEL_IDS.has(spark)).toBe(true);
    expect(catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "oauth", "oauth")).toBe(
      false,
    );
    const oauthCatalog = listAvailablePiCatalog({ [CHATGPT_OAUTH_PROVIDER]: "oauth" });
    expect(
      oauthCatalog.some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark),
    ).toBe(false);
    expect(
      oauthCatalog.some(
        (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === "gpt-6-luna",
      ),
    ).toBe(true);
  });

  it("lets a model-specific auth kind override the provider kind", () => {
    const spark = "gpt-5.3-codex-spark";
    const oauthProvider = { [CHATGPT_OAUTH_PROVIDER]: "oauth" as const };
    expect(
      listAvailablePiCatalog(oauthProvider).some(
        (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark,
      ),
    ).toBe(false);
    expect(
      listAvailablePiCatalog(oauthProvider, {
        [CHATGPT_OAUTH_PROVIDER]: { [spark]: "api_key" },
      }).some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark),
    ).toBe(true);
    expect(
      listAvailablePiCatalog(
        { [CHATGPT_OAUTH_PROVIDER]: "api_key" },
        { [CHATGPT_OAUTH_PROVIDER]: { [spark]: "disconnected" } },
      ).some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark),
    ).toBe(false);
  });

  it("keeps Codex Spark when the provider credential is an API key", () => {
    expect(catalogModelAvailableForAuth(CHATGPT_OAUTH_PROVIDER, spark, "api_key", "oauth")).toBe(
      true,
    );
    const apiKeyCatalog = listAvailablePiCatalog({ [CHATGPT_OAUTH_PROVIDER]: "api_key" });
    expect(
      apiKeyCatalog.some(
        (entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark,
      ),
    ).toBe(true);
  });

  it("hides Spark while openai-codex is disconnected because only subscription sign-in is offered", () => {
    const disconnected = listAvailablePiCatalog();
    expect(
      disconnected.some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark),
    ).toBe(false);
  });

  it("still lists Spark on the OpenAI API key provider", () => {
    const catalog = listPiCatalog();
    expect(catalog.some((entry) => entry.provider === "openai" && entry.id === spark)).toBe(true);
    expect(
      catalog.some((entry) => entry.provider === CHATGPT_OAUTH_PROVIDER && entry.id === spark),
    ).toBe(true);
  });

  it("detects oauth credentials from stored JSON", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(modelCredentialAuthKindFromPlaintext(oauth)).toBe("oauth");
    expect(modelCredentialAuthKindFromPlaintext("sk-test-api-key-12345678")).toBe("api_key");
  });

  it("does not treat corrupt stored credential JSON as an API key", () => {
    const corrupt = JSON.stringify({ kind: "oauth", credential: { type: "oauth" } });
    expect(() => modelCredentialAuthKindFromPlaintext(corrupt)).toThrow(/corrupt/);
  });
});
