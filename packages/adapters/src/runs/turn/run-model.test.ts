import { expect, it } from "vitest";
import { resolvedModelRunFields } from "./run-model.js";

const resolved = { apiKey: "fixture-key", redact: [], callObserver: undefined, connectionId: "c" };

it("runs at the level the model's settings chose when the run chose none", () => {
  const withLevel = { ...resolved, reasoning: true, thinkingLevel: "max" as const };
  expect(resolvedModelRunFields(withLevel, null).thinkingLevel).toBe("max");
  expect(resolvedModelRunFields(withLevel, undefined).thinkingLevel).toBe("max");
  expect(resolvedModelRunFields(withLevel, "low").thinkingLevel).toBe("low");
  expect(resolvedModelRunFields(withLevel, "off").thinkingLevel).toBe("off");
  expect(resolvedModelRunFields(resolved, null).thinkingLevel).toBeNull();
});
