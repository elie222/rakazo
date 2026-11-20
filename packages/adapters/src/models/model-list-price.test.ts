import { expect, it } from "vitest";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/cli-model/claude-code/provider-id.js";
import { CHATGPT_OAUTH_PROVIDER } from "../runtime/pi/models/pi-oauth.js";
import { modelListCost } from "./model-list-price.js";
import { catalogModels } from "./model-vision.js";

const million = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
};
const counted = (missing: Partial<Record<keyof typeof million, true>> = {}) => ({
  calls: 2,
  counted: {
    inputTokens: missing.inputTokens ? 1 : 2,
    outputTokens: missing.outputTokens ? 1 : 2,
    cacheReadTokens: missing.cacheReadTokens ? 1 : 2,
    cacheWriteTokens: missing.cacheWriteTokens ? 1 : 2,
  },
  tokens: million,
});

it("prices Claude Code's calls at the same Anthropic model's list rates", () => {
  const rates = catalogModels().getModel("anthropic", "claude-sonnet-5-5")?.cost;
  expect(rates?.input).toBeGreaterThan(0);
  const cost = modelListCost(CLAUDE_CODE_PROVIDER_ID, "claude-sonnet-5-5", counted());
  expect(cost?.usd).toBeCloseTo(
    rates!.input + rates!.output + rates!.cacheRead + rates!.cacheWrite,
  );
  expect(cost?.complete).toBe(true);
});

it("reads a missing count as a floor, except Claude Code's absent cache counts, which are zero", () => {
  const sonnet = (missing: Parameters<typeof counted>[0]) =>
    modelListCost(CLAUDE_CODE_PROVIDER_ID, "claude-sonnet-5-5", counted(missing))?.complete;
  expect(sonnet({ cacheReadTokens: true, cacheWriteTokens: true })).toBe(true);
  expect(sonnet({ inputTokens: true })).toBe(false);

  const codex = catalogModels()
    .getModels(CHATGPT_OAUTH_PROVIDER)
    .find((model) => model.cost.cacheWrite > 0);
  expect(codex).toBeDefined();
  expect(
    modelListCost(CHATGPT_OAUTH_PROVIDER, codex!.id, counted({ cacheWriteTokens: true }))?.complete,
  ).toBe(false);
});

it("has no price for a model the catalog does not price", () => {
  expect(modelListCost("custom", "in-house-model", counted())).toBeNull();
  expect(modelListCost(CLAUDE_CODE_PROVIDER_ID, "claude-not-a-model", counted())).toBeNull();
});
