import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { providerDisplayName, providerRowHint } from "./localized-provider-hint";

const entry = (overrides: Partial<ModelCatalogEntry>) =>
  ({ provider: "p", id: "m", label: "M", auth: "api-key", ...overrides }) as ModelCatalogEntry;

describe("providerDisplayName", () => {
  it("names the OpenAI-compatible server as the third-party option", () => {
    expect(providerDisplayName("openai-compatible", "OpenAI-compatible")).toBe("Third-party model");
  });

  it("names subscriptions by the plan and passes other providers through", () => {
    expect(providerDisplayName("openai-codex", "OpenAI Codex")).toBe("ChatGPT subscription");
    expect(providerDisplayName("anthropic", "Anthropic", "sign-in")).toBe("Claude subscription");
    expect(providerDisplayName("openai", "OpenAI")).toBe("OpenAI");
  });
});

describe("providerRowHint", () => {
  it("shows nothing for a plain API-key provider", () => {
    expect(providerRowHint(entry({}))).toBeNull();
  });

  it("keeps the hint for sign-in, subscription and custom-server providers", () => {
    expect(providerRowHint(entry({ authHint: "Custom server" }))).toBe("Custom server");
    expect(providerRowHint(entry({ signIn: "device-code" }))).toBe("Sign in");
    expect(providerRowHint(entry({ auth: "oauth" }))).toBe("Skip or deploy key");
  });
});
