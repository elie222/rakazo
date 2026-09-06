import { afterEach, describe, expect, it } from "vitest";
import { modelsForRequest } from "./pi-runtime.js";
import { workmateClaudeProvider } from "./workmate-claude.js";

const keys = ["WORKMATE_CLAUDE_BASE_URL", "WORKMATE_CLAUDE_MODELS"] as const;
const saved = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("WorkMate Claude provider", () => {
  it("keeps the existing provider id and configured model ids", () => {
    process.env.WORKMATE_CLAUDE_BASE_URL = "http://127.0.0.1:8788/v1";
    process.env.WORKMATE_CLAUDE_MODELS = "claude-sonnet-5, fable";

    const provider = workmateClaudeProvider();

    const catalog = modelsForRequest(
      { model: { provider: "workmate-claude", id: "fable" } },
      "workmate-claude",
    );
    expect(catalog.getModel("workmate-claude", "fable")?.baseUrl).toBe("http://127.0.0.1:8788/v1");

    expect(provider?.id).toBe("workmate-claude");
    expect(provider?.getModels().map((model) => model.id)).toEqual(["claude-sonnet-5", "fable"]);
  });
});
