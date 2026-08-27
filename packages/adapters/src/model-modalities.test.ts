import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const VISION_ENV = "RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS";
const LOCAL_VISION_ENV = "RAKAZO_LOCAL_VISION_MODELS";

/**
 * The vision gate memoizes its catalog at module scope, so every case has to
 * start from a fresh module graph or it would read the previous case's env.
 */
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>) {
  const previous = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("operator-declared vision modalities", () => {
  it("defaults openai-compatible models to text-only", async () => {
    await withEnv({ [VISION_ENV]: undefined }, async () => {
      const { modelAcceptsImageInput } = await import("./model-vision.js");
      expect(modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")).toBe(false);
    });
  });

  it("lets the vision gate see a declared openai-compatible vision model", async () => {
    await withEnv({ [VISION_ENV]: "gpt4o-vision, another-vision " }, async () => {
      const { modelAcceptsImageInput } = await import("./model-vision.js");
      expect(modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")).toBe(true);
      expect(modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "another-vision")).toBe(true);
    });
  });

  it("leaves undeclared models on the same endpoint text-only", async () => {
    await withEnv({ [VISION_ENV]: "gpt4o-vision" }, async () => {
      const { modelAcceptsImageInput } = await import("./model-vision.js");
      expect(modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "text-only-model")).toBe(false);
    });
  });

  it("keeps the screenshot-returning computer tools when the model is declared", async () => {
    await withEnv({ [VISION_ENV]: "gpt4o-vision" }, async () => {
      const { modelAcceptsImageInput, filterImageReturningComputerTools } = await import(
        "./model-vision.js"
      );
      const tools = [{ name: "computer_observe" }, { name: "computer_act" }, { name: "bash" }];
      const accepts = modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision");
      expect(filterImageReturningComputerTools(tools, accepts).map((t) => t.name)).toEqual([
        "computer_observe",
        "computer_act",
        "bash",
      ]);
    });
  });

  it("strips them again when nothing is declared", async () => {
    await withEnv({ [VISION_ENV]: undefined }, async () => {
      const { modelAcceptsImageInput, filterImageReturningComputerTools } = await import(
        "./model-vision.js"
      );
      const tools = [{ name: "computer_observe" }, { name: "bash" }];
      const accepts = modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision");
      expect(filterImageReturningComputerTools(tools, accepts).map((t) => t.name)).toEqual(["bash"]);
    });
  });

  it("declares image input on the runtime-registered model", async () => {
    await withEnv({ [VISION_ENV]: "gpt4o-vision" }, async () => {
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const { registerOpenAiCompatibleRuntime } = await import(
        "./pi-openai-compatible-provider.js"
      );
      const models = registerOpenAiCompatibleRuntime(builtinModels(), {
        modelId: "gpt4o-vision",
        baseUrl: "http://127.0.0.1:4000/v1",
      });
      expect(
        models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")?.input,
      ).toContain("image");
    });
  });

  it("applies the same declaration to the local provider", async () => {
    await withEnv(
      { RAKAZO_LOCAL_MODELS: "qwen3-vl,qwen3-text", [LOCAL_VISION_ENV]: "qwen3-vl" },
      async () => {
        const { localProvider } = await import("./pi-local-provider.js");
        const models = localProvider()?.getModels() ?? [];
        expect(models.find((m) => m.id === "qwen3-vl")?.input).toContain("image");
        expect(models.find((m) => m.id === "qwen3-text")?.input).not.toContain("image");
      },
    );
  });
});
