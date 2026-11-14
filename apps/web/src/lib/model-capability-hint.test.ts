import { expect, it } from "vitest";
import { modelCapabilityHint } from "./model-capability-hint";

it("summarizes only the capabilities a model listing confirms", () => {
  expect(modelCapabilityHint(undefined)).toBe("");
  expect(modelCapabilityHint({ id: "a" })).toBe("");
  expect(modelCapabilityHint({ id: "a", supportsImages: false, reasoning: false })).toBe("");
  expect(modelCapabilityHint({ id: "a", supportsImages: true })).toBe("Images");
  expect(modelCapabilityHint({ id: "a", supportsImages: true, reasoning: true })).toBe(
    "Images · Thinking",
  );
});
