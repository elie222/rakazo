import { expect, it } from "vitest";
import { modelCapabilityHint, presetApiKeyPlaceholder } from "./compatible-preset";

it("labels the key field of a hosted preset with its name and leaves ordinary servers alone", () => {
  expect(presetApiKeyPlaceholder({ name: "Hosted Example" })).toBe("API key for Hosted Example");
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
