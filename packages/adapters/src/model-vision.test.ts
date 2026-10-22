import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  filterImageReturningComputerTools,
  IMAGE_RETURNING_COMPUTER_TOOLS,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  resolveModelRefForVisionCheck,
  updateModelImageCapabilities,
} from "./model-vision.js";
import { liveCatalogEntry } from "./pi-live-catalog.js";
import { resolveRuntimeModel } from "./pi-runtime.js";

describe("model vision gating for computer tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats catalog text-only models as unable to see", () => {
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
  });

  it("treats catalog vision models as able to see", () => {
    expect(modelAcceptsImageInput("openrouter", "openai/gpt-4o")).toBe(true);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-vision-exp")).toBe(
      true,
    );
  });

  it("sees models the runtime adds to the bundled catalog", () => {
    expect(modelAcceptsImageInput("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(modelAcceptsImageInput("openai-codex", "gpt-6.1-sol")).toBe(true);
  });

  it.each([
    ["openai", "gpt-4o-2099-01-01", true],
    ["openai-codex", "gpt-6-luna-latest", true],
    ["openai-codex", "gpt-unknown-future-model", false],
  ])("agrees with listing and execution for live %s/%s", (provider, id, images) => {
    expect(liveCatalogEntry(provider, id)?.images).toBe(images);
    expect(resolveRuntimeModel({ provider, id }).model?.input.includes("image")).toBe(images);
    expect(modelAcceptsImageInput(provider, id)).toBe(images);
    const tools = filterImageReturningComputerTools(
      builtinAgentTools,
      modelAcceptsImageInput(provider, id),
    );
    expect(tools.some((tool) => tool.name === "computer_observe")).toBe(images);
  });

  it("resolves the scripted placeholder like Pi before checking vision", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-6-luna",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);

    vi.stubEnv("PI_DEFAULT_MODEL", "openai/gpt-4o");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-4o",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);
  });

  it("treats unknown models as text-only", () => {
    expect(modelAcceptsImageInput("openrouter", "rakazo-test/unknown-future-model")).toBe(false);
  });

  it("keeps explicit image capability scoped to the selected model", () => {
    const enabled = updateModelImageCapabilities(
      [" vision-model ", "text-model"],
      "text-model",
      false,
    );
    expect(enabled).toEqual(["vision-model"]);
    expect(modelIdSupportsImages(enabled, "vision-model")).toBe(true);
    expect(modelIdSupportsImages(enabled, "text-model")).toBe(false);
  });

  it("omits image-returning computer tools for text-only models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, false).map(
      (tool) => tool.name,
    );
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
    expect(names).toContain("list_files");
  });

  it("keeps image-returning computer tools for vision models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, true).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(builtinAgentTools.map((tool) => tool.name));
    expect(names).toContain("computer_observe");
    expect(names).toContain("computer_act");
  });
});
