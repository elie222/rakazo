import { expect, it } from "vitest";
import { decisionModel, decisionModelCatalog } from "./decision-models.js";

it.each([
  ["openrouter", "typesafe/jev-1.14", "https://openrouter.ai/typesafe/jev-1.14"],
  ["typesafe", "jev-latest", "https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost"],
  ["typesafe", "jev-1.14", "https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost"],
  [
    "openrouter",
    "microsoft/microsoft-decision-1.1",
    "https://openrouter.ai/microsoft/microsoft-decision-1.1",
  ],
])("resolves %s/%s through its provider descriptor", (provider, id, pricingUrl) => {
  expect(decisionModel(provider, id)).toMatchObject({ inputUsdPerMillion: 0.042, pricingUrl });
});
it("keeps protocol IDs provider-scoped and publishes only declared catalog entries", () => {
  expect(decisionModel("openrouter", "jev-latest")).toBeUndefined();
  expect(decisionModel("unknown", "jev-latest")).toBeUndefined();
  expect(decisionModelCatalog()).toEqual([
    expect.objectContaining({
      provider: "openrouter",
      id: "typesafe/jev-1.14",
      protocol: "decisions",
      // The connection form offers zero data retention only where the catalog says it holds.
      dataRetentionControl: true,
    }),
    expect.objectContaining({
      provider: "openrouter",
      id: "microsoft/microsoft-decision-1.1",
      protocol: "decisions",
      dataRetentionControl: true,
    }),
  ]);
});
