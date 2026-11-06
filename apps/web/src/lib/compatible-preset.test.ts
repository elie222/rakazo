import { DEEPINFRA_BASE_URL, OLLAMA_CLOUD_BASE_URL } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  modelCapabilityHint,
  presetApiKeyPlaceholder,
  probedModelFields,
} from "./compatible-preset";

it("labels the key field of each hosted preset and leaves ordinary servers alone", () => {
  expect(presetApiKeyPlaceholder(OLLAMA_CLOUD_BASE_URL)).toBe("Ollama API key");
  expect(presetApiKeyPlaceholder(`${DEEPINFRA_BASE_URL}/`)).toBe("DeepInfra API key");
  expect(presetApiKeyPlaceholder("http://127.0.0.1:8000/v1")).toBeUndefined();
  expect(presetApiKeyPlaceholder(undefined)).toBeUndefined();
});

it("summarizes only the capabilities a model listing confirms", () => {
  expect(modelCapabilityHint(undefined)).toBe("");
  expect(modelCapabilityHint({ id: "a" })).toBe("");
  expect(modelCapabilityHint({ id: "a", supportsImages: false, reasoning: false })).toBe("");
  expect(modelCapabilityHint({ id: "a", supportsImages: true })).toBe("Images");
  expect(modelCapabilityHint({ id: "a", supportsImages: true, reasoning: true })).toBe(
    "Images · Thinking",
  );
});

it("prefills only the fields the listing publishes", () => {
  expect(probedModelFields(undefined, "4096")).toEqual({});
  expect(probedModelFields({ id: "a" }, "4096")).toEqual({});
  expect(
    probedModelFields(
      { id: "a", supportsImages: false, reasoning: true, contextWindow: 131072 },
      "4096",
    ),
  ).toEqual({ supportsImages: false, reasoning: true, contextWindow: "131072" });
});

it("lowers the output limit when a published context limit leaves no room for input", () => {
  expect(probedModelFields({ id: "a", contextWindow: 4096 }, "4096")).toEqual({
    contextWindow: "4096",
    maxTokens: "2048",
  });
  expect(probedModelFields({ id: "a", contextWindow: 8192 }, "4096")).toEqual({
    contextWindow: "8192",
  });
});
