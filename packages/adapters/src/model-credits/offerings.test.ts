import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedModelCreditOffering, modelCreditOfferings, offeringUsage } from "./offerings.js";

const entry = {
  id: "offering-a",
  connectionId: "connection-a",
  provider: "provider-a",
  modelId: "model-a",
  price: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 },
};
const configuration = { defaultOfferingId: entry.id, offerings: [entry] };
afterEach(() => vi.unstubAllEnvs());
describe("deployment model credit offerings", () => {
  it("preserves the legacy path only when configuration is absent", () => {
    expect(modelCreditOfferings({})).toBeUndefined();
    expect(() => modelCreditOfferings({ MODEL_CREDIT_OFFERINGS: "" })).toThrow(
      "Invalid MODEL_CREDIT_OFFERINGS",
    );
  });
  it.each([
    { ...configuration, defaultOfferingId: "missing" },
    { ...configuration, offerings: [entry, entry] },
    { ...configuration, offerings: [{ ...entry, apiKey: "fake-secret" }] },
    { ...configuration, offerings: [{ ...entry, price: { ...entry.price, input: 0 } }] },
    { ...configuration, offerings: [{ ...entry, price: { ...entry.price, output: -1 } }] },
  ])("rejects invalid operator configuration without echoing its contents", (value) => {
    expect(() => modelCreditOfferings({ MODEL_CREDIT_OFFERINGS: JSON.stringify(value) })).toThrow(
      "Invalid MODEL_CREDIT_OFFERINGS configuration",
    );
  });
  it("allows withdrawing every offering without restoring legacy routing", () => {
    expect(
      modelCreditOfferings({ MODEL_CREDIT_OFFERINGS: '{"defaultOfferingId":null,"offerings":[]}' }),
    ).toEqual({ defaultOfferingId: null, offerings: [] });
  });
  it("requires an exact approved provider/model pair", () => {
    vi.stubEnv("MODEL_CREDIT_OFFERINGS", JSON.stringify(configuration));
    expect(approvedModelCreditOffering("provider-a", "model-a")).toEqual(entry);
    expect(approvedModelCreditOffering("provider-a", "model-b")).toBeUndefined();
    expect(approvedModelCreditOffering("provider-b", "model-a")).toBeUndefined();
  });
  it("charges measured tokens at the customer tariff even when the upstream bill is free", () => {
    expect(
      offeringUsage(entry, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        costSource: "provider-reported",
      }),
    ).toMatchObject({ costUsd: 5, costSource: "deployment-tariff" });
  });
  it("retains unknown usage and preserves the tariff for recovery", () => {
    expect(
      offeringUsage(entry, { inputTokens: null, outputTokens: null, costUsd: null }),
    ).toMatchObject({
      costUsd: null,
      pricingSnapshot: { connectionId: entry.connectionId },
    });
    expect(offeringUsage(entry, { inputTokens: 10, outputTokens: null, costUsd: 0 })).toMatchObject(
      { costUsd: null },
    );
  });
});

it("reuses validated configuration until the environment value changes", () => {
  const env = { MODEL_CREDIT_OFFERINGS: JSON.stringify(configuration) };
  const first = modelCreditOfferings(env);
  expect(modelCreditOfferings(env)).toBe(first);
  env.MODEL_CREDIT_OFFERINGS = '{"defaultOfferingId":null,"offerings":[]}';
  expect(modelCreditOfferings(env)).not.toBe(first);
  env.MODEL_CREDIT_OFFERINGS = "invalid";
  expect(() => modelCreditOfferings(env)).toThrow("Invalid MODEL_CREDIT_OFFERINGS");
});
it("prices only measured buckets with nonzero customer rates", () => {
  const usage = { inputTokens: 1000000, outputTokens: 1000000, costUsd: 0 };
  expect(
    offeringUsage({ ...entry, price: { ...entry.price, cacheRead: 0, cacheWrite: 0 } }, usage),
  ).toMatchObject({ costUsd: 5 });
  expect(offeringUsage(entry, usage)).toMatchObject({ costUsd: null });
});
