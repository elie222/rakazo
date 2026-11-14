import { expect, it } from "vitest";
import { modelCapabilityHint } from "./model-capability-hint.js";

const labels = { images: "Images", thinking: "Thinking" };

it("lists only the capabilities the listing reports, in the caller's words", () => {
  expect(modelCapabilityHint(undefined, labels)).toBe("");
  expect(modelCapabilityHint({}, labels)).toBe("");
  expect(modelCapabilityHint({ supportsImages: false, reasoning: false }, labels)).toBe("");
  expect(modelCapabilityHint({ supportsImages: true }, labels)).toBe("Images");
  expect(modelCapabilityHint({ reasoning: true }, labels)).toBe("Thinking");
  expect(modelCapabilityHint({ supportsImages: true, reasoning: true }, labels)).toBe(
    "Images · Thinking",
  );
  expect(modelCapabilityHint({ reasoning: true }, { images: "Bilder", thinking: "Denken" })).toBe(
    "Denken",
  );
});
