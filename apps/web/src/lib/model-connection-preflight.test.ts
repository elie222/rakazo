import { describe, expect, it, vi } from "vitest";
import {
  classifyModelConnectionFailure,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "./model-connection-preflight.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (value: number, forms: { one: string; other: string }) =>
    (value === 1 ? forms.one : forms.other).replaceAll("#", String(value)),
}));

describe("classifyModelConnectionFailure", () => {
  it("detects rate limits and timeouts", () => {
    expect(classifyModelConnectionFailure(new Error("429 rate limit")).outcome).toBe("rate_limit");
    expect(classifyModelConnectionFailure(new Error("probe timed out")).outcome).toBe("timeout");
    expect(classifyModelConnectionFailure(new Error("The operation was aborted")).outcome).toBe(
      "unknown",
    );
  });

  it("reads the kind of failure from the provider's words, even ones the key repeats", () => {
    const failure = classifyModelConnectionFailure(new Error("unauthorized: invalid key"), {
      secrets: ["unauthorized"],
    });
    expect(failure.outcome).toBe("unauthorized");
    expect(failure.message).toBe("•••: invalid key");
  });

  it.each([
    ["rate_limit", "429 Too Many Requests"],
    ["rate_limit", "HTTP 429"],
    ["unauthorized", "Request failed with status 401"],
    ["unauthorized", "HTTP 403: forbidden"],
  ])("reads %s from the status code in %j", (outcome, message) => {
    expect(classifyModelConnectionFailure(new Error(message)).outcome).toBe(outcome);
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:4030",
    "connect ECONNREFUSED 127.0.0.1:14290",
    "connect ECONNREFUSED 10.0.0.1:34010",
  ])("does not read a port or id as a status code in %j", (message) => {
    expect(classifyModelConnectionFailure(new Error(message)).outcome).toBe("unreachable");
  });

  it("hides the credentials the connection was tested with, wherever the message has them", () => {
    const failure = classifyModelConnectionFailure(
      new Error("401 denied for EXAMPLE-PLACEHOLDER-KEY with tenant EXAMPLE-HEADER-VALUE"),
      { secrets: ["EXAMPLE-PLACEHOLDER-KEY", "EXAMPLE-HEADER-VALUE", undefined] },
    );
    expect(failure).toMatchObject({
      outcome: "unauthorized",
      message: "401 denied for ••• with tenant •••",
    });
  });

  it("hides a credential shape it was not told about", () => {
    expect(
      classifyModelConnectionFailure(new Error("Incorrect API key provided: EXAMPLE-1234."))
        .message,
    ).toBe("Incorrect API key provided: •••.");
  });

  it("keeps manual model entry for custom servers and catalog picks for catalog providers", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.nextAction).toMatch(
      /enter a model id/,
    );
    expect(
      unavailableSelectedModel("gpt-missing", ["gpt-test"], { manualEntry: false })?.nextAction,
    ).toBe("Pick a model from the catalog.");
  });
});

describe("unavailableSelectedModel", () => {
  it("fails only when a non-empty list omits the selected id", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.outcome).toBe(
      "unavailable_model",
    );
    expect(unavailableSelectedModel("gpt-test", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("gpt-missing", [])).toBeNull();
  });
});

describe("runModelConnectionPreflight", () => {
  it("probes catalog providers through the pinned catalog endpoint", async () => {
    const probeCatalog = vi.fn().mockResolvedValue({ models: ["gpt-test"] });
    const result = await runModelConnectionPreflight({
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "gpt-test",
      catalogProbe: true,
      probeCatalog,
    });
    expect(result.ok).toBe(true);
    expect(probeCatalog).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
    });
  });

  it("rejects a selected model the catalog probe did not list", async () => {
    const result = await runModelConnectionPreflight({
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "missing-model",
      catalogProbe: true,
      probeCatalog: async () => ({ models: ["gpt-test"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("unavailable_model");
    }
  });

  it("hides the tested key in a failed probe's message", async () => {
    const result = await runModelConnectionPreflight({
      provider: "openrouter",
      apiKey: " EXAMPLE-PLACEHOLDER-KEY ",
      catalogProbe: true,
      probeCatalog: async () => {
        throw new Error('Headers.append: "Bearer EXAMPLE-PLACEHOLDER-KEY" is an invalid header.');
      },
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { message: 'Headers.append: "Bearer •••" is an invalid header.' },
    });
  });

  it("rejects providers without a pinned catalog endpoint", async () => {
    const result = await runModelConnectionPreflight({
      provider: "anthropic",
      apiKey: "sk-test-key-12345678",
      catalogProbe: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.outcome).toBe("unknown");
  });
});

describe("modelPreflightSuccessMessage", () => {
  it("reports a models-list check and does not ask catalog users to type an id", () => {
    expect(modelPreflightSuccessMessage(1)).toBe(
      "Models list OK. 1 model available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(466)).toBe(
      "Models list OK. 466 models available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(0)).toBe("No models listed.");
    expect(modelPreflightSuccessMessage(0)).not.toMatch(/model id/i);
  });
});
