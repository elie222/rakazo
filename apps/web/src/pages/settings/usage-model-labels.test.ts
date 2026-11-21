import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { expect, it } from "vitest";
import { usageModelKey, usageModelLabels } from "./usage-model-labels";

it("indexes a large history while preserving matching distinct row and filter labels", () => {
  const models = Array.from({ length: 100_000 }, (_, index) => ({
    provider: "alpha",
    model: `model-${String(index).padStart(6, "0")}`,
  }));
  const catalog = models.map((model) => ({
    provider: model.provider,
    id: model.model,
    label: "Shared model",
    providerName: "Alpha AI",
  }));
  expectLinearTime(() => {
    const labels = usageModelLabels(models, catalog, "Unlisted model");
    expect(labels.options).toHaveLength(models.length);
    expect(labels.byKey.get(usageModelKey(models[0]!))).toBe(labels.options[0]);
    expect(labels.options[0]?.label).toBe("1. Shared model (Alpha AI)");
    expect(labels.byKey.get(usageModelKey(models.at(-1)!))?.label).toBe(
      "100000. Shared model (Alpha AI)",
    );
  });
});
