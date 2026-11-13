// @vitest-environment jsdom

import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettingsFields } from "./model-settings-fields.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const limits = {
  contextWindow: "2000000",
  onContextWindowChange: () => {},
  contextWindowLabel: "Context limit",
  maxTokens: "393216",
  onMaxTokensChange: () => {},
  maxTokensLabel: "Maximum output tokens",
};

it("bounds the limit inputs by the limits the server accepts", () => {
  const container = render(<ModelSettingsFields {...limits} />);
  const [contextWindow, maxTokens] = container.querySelectorAll<HTMLInputElement>("input");
  expect(contextWindow?.max).toBe(String(MAX_MODEL_CONTEXT_WINDOW));
  expect(maxTokens?.max).toBe(String(MAX_MODEL_MAX_TOKENS));
});

it("shows image and thinking settings only where the model's capabilities are configurable", () => {
  const capabilities = {
    onImagesChange: () => {},
    imagesLabel: "Supports images",
    onReasoningChange: () => {},
    reasoningLabel: "Supports thinking",
  };
  expect(render(<ModelSettingsFields {...limits} {...capabilities} />).textContent).not.toContain(
    "Supports images",
  );
  const configurable = render(<ModelSettingsFields {...limits} {...capabilities} capabilities />);
  expect(configurable.textContent).toContain("Supports images");
  expect(configurable.textContent).toContain("Supports thinking");
});

it("offers an image limit whenever the model reads images", () => {
  const imageLimit = { onMaxImagesPerPromptChange: () => {}, maxImagesLabel: "Maximum images" };
  expect(render(<ModelSettingsFields {...limits} {...imageLimit} images />).textContent).toContain(
    "Maximum images",
  );
  expect(render(<ModelSettingsFields {...limits} {...imageLimit} />).textContent).not.toContain(
    "Maximum images",
  );
});
