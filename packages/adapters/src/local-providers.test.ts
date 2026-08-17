import { createModels, hasApi } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { withLocalProviders } from "./local-providers.js";

describe("Local MLX provider reasoning config", () => {
  it("disables Qwen's <think> block by default instead of always reasoning at max effort", () => {
    const models = withLocalProviders(createModels());
    const provider = models.getProvider("local-mlx");
    const [model] = provider?.getModels() ?? [];
    if (!model || !hasApi(model, "openai-completions")) {
      throw new Error("expected an openai-completions local-mlx model");
    }

    expect(model.reasoning).toBe(true);
    expect(model.compat?.thinkingFormat).toBe("qwen-chat-template");
  });

  it("sends the system prompt as role 'system', not the 'developer' role mlx-openai-server rejects", () => {
    const models = withLocalProviders(createModels());
    const provider = models.getProvider("local-mlx");
    const [model] = provider?.getModels() ?? [];
    if (!model || !hasApi(model, "openai-completions")) {
      throw new Error("expected an openai-completions local-mlx model");
    }

    expect(model.compat?.supportsDeveloperRole).toBe(false);
  });
});
