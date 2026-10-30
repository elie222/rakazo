import { describe, expect, it } from "vitest";
import { type BotRoute, selectBotRoute } from "./bot-route-selection.js";

const fallback: BotRoute = {
  label: "default",
  provider: "configured",
  modelId: "main",
  execution: "inline",
};
const fast: BotRoute = { ...fallback, label: "fast", modelId: "small" };
const input = {
  enabled: true,
  routes: [fast],
  defaultRoute: fallback,
  isValid: (_route: BotRoute) => true,
};

describe("constrained route selection", () => {
  it("selects a configured tuple from one exact label", () => {
    expect(selectBotRoute({ ...input, classifierLabel: "fast" })).toEqual({
      route: fast,
      source: "classifier",
    });
  });

  it("preserves explicit and persisted choices without silent model fallback", () => {
    expect(selectBotRoute({ ...input, explicit: fallback, classifierLabel: "fast" }).source).toBe(
      "explicit",
    );
    expect(selectBotRoute({ ...input, persisted: fast, explicit: fallback }).source).toBe(
      "persisted",
    );
    expect(() => selectBotRoute({ ...input, persisted: fast, isValid: () => false })).toThrow(
      "pinned or explicit",
    );
  });

  it.each([
    [{ enabled: false }, "disabled"],
    [{ classifierLabel: undefined }, "missing-label"],
    [{ classifierLabel: "https://unapproved.example" }, "unknown-label"],
    [{ classifierLabel: "fast", routes: [fast, fast] }, "unknown-label"],
  ] as const)("uses the validated default for %j", (patch, fallbackReason) => {
    expect(selectBotRoute({ ...input, ...patch })).toEqual({
      route: fallback,
      source: "default",
      fallbackReason,
    });
  });

  it("validates selected and fallback tuples independently", () => {
    expect(
      selectBotRoute({
        ...input,
        classifierLabel: "fast",
        isValid: (route) => route.modelId === "main",
      }),
    ).toEqual({ route: fallback, source: "default", fallbackReason: "invalid-route" });
    expect(() => selectBotRoute({ ...input, isValid: () => false })).toThrow("No valid configured");
  });
});
