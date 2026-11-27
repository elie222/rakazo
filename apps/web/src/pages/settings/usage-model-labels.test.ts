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

it("resolves cross-region and versioned model IDs against catalog siblings without leaking raw IDs", () => {
  const catalog = [
    {
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      providerName: "Amazon Bedrock",
    },
    {
      provider: "anthropic",
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      providerName: "Anthropic",
    },
  ];
  const labels = usageModelLabels(
    [
      { provider: "amazon-bedrock", model: "ap.anthropic.claude-sonnet-5-5-v1:0" },
      { provider: "amazon-bedrock", model: "global.anthropic.claude-opus-4-6-v1" },
      { provider: "custom", model: "opaque-private-model" },
    ],
    catalog,
    "Unlisted model",
  );
  expect(
    labels.labelsFor({ provider: "amazon-bedrock", model: "ap.anthropic.claude-sonnet-5-5-v1:0" }),
  ).toEqual({
    modelLabel: "Claude Sonnet 5.5",
    providerLabel: "Amazon Bedrock",
  });
  expect(
    labels.labelsFor({ provider: "amazon-bedrock", model: "global.anthropic.claude-opus-4-6-v1" }),
  ).toEqual({
    modelLabel: "Claude Opus 4.6",
    providerLabel: "Amazon Bedrock",
  });
  expect(labels.labelsFor({ provider: "custom", model: "opaque-private-model" })).toEqual({
    modelLabel: "Unlisted model",
    providerLabel: undefined,
  });
  expect(
    labels.labelsFor({
      provider: "openai-compatible",
      model: "bedrock/global.anthropic.claude-sonnet-5-5-v1:0",
    }),
  ).toEqual({
    modelLabel: "Claude Sonnet 5.5",
    providerLabel: undefined,
  });
});
