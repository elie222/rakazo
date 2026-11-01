import type { AdapterContext, DecisionRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { HttpDecisionProvider } from "./http-decisions.js";

const context: AdapterContext = {
  operationId: "review",
  traceId: "trace",
  userId: "user",
  spaceId: "space",
  runId: "run",
  signal: new AbortController().signal,
};
const request: DecisionRequest = {
  model: "typesafe/jev-1.14",
  state: { task: "fake task" },
  questions: {
    decision: {
      type: "choice",
      instructions: "Choose",
      criteria: { pass: "Safe", ask: "Needs a person" },
    },
  },
};
const response = (choice = "pass") =>
  new Response(
    JSON.stringify({
      id: "fake-request",
      model: request.model,
      answers: { decision: { type: "choice", choice, confidence: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 },
    }),
  );

describe.each(["openrouter", "typesafe"] as const)("%s decision conformance", (provider) => {
  it("translates requests, validates choices, and reports paid usage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response());
    const onUsage = vi.fn();
    const beforeCall = vi.fn().mockResolvedValue("reservation");
    const afterCall = vi.fn();
    const result = await new HttpDecisionProvider(provider, {
      apiKey: "fake-key",
      fetch: fetchMock,
      onUsage,
      callObserver: { beforeCall, afterCall },
    }).decide(request, context);
    expect(result.answers.decision).toEqual({ type: "choice", choice: "pass", confidence: 0.9 });
    expect(fetchMock).toHaveBeenCalledWith(
      provider === "openrouter"
        ? "https://openrouter.ai/api/alpha/decisions"
        : "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        redirect: "error",
        body: JSON.stringify(request),
        signal: context.signal,
      }),
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        model: request.model,
        callId: expect.any(String),
        costSource: "provider-reported",
        costUsd: 0.0000042,
      }),
    );
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({ costUsd: 0.0000042 }),
    );
    if (provider === "openrouter")
      expect(beforeCall).toHaveBeenCalledWith(
        expect.objectContaining({ maxCostUsd: expect.any(Number) }),
      );
  });
  it("rejects unknown answers while retaining provider costs", async () => {
    const onUsage = vi.fn();
    await expect(
      new HttpDecisionProvider(provider, {
        apiKey: "fake-key",
        fetch: async () => response("unknown"),
        onUsage,
      }).decide(request, context),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.0000042 }));
  });
  it("releases reservations on explicit provider rejection without exposing response bodies", async () => {
    const afterCall = vi.fn();
    await expect(
      new HttpDecisionProvider(provider, {
        apiKey: "fake-key",
        fetch: async () => new Response("fake-key", { status: 401 }),
        callObserver: { beforeCall: () => "reservation", afterCall },
      }).decide(request, context),
    ).rejects.toMatchObject({ kind: "authentication" });
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({ costUsd: 0, usageSource: "provider-rejected" }),
    );
  });
  it("does not call a provider when reservation fails", async () => {
    const fetchMock = vi.fn();
    await expect(
      new HttpDecisionProvider(provider, {
        apiKey: "fake-key",
        fetch: fetchMock,
        callObserver: {
          beforeCall: () => {
            throw new Error("Credits unavailable");
          },
          afterCall: vi.fn(),
        },
      }).decide(request, context),
    ).rejects.toThrow("Credits unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("decision provider failures", () => {
  it("refuses a blank API key before any request", () => {
    expect(() => new HttpDecisionProvider("typesafe", { apiKey: " " })).toThrow(
      expect.objectContaining({ kind: "authentication" }),
    );
  });

  it.each([
    [422, "invalid", { costUsd: 0, usageSource: "provider-rejected" }],
    [429, "busy", { costUsd: 0, usageSource: "provider-rejected" }],
    [503, "unavailable", null],
  ] as const)(
    "maps HTTP %i to %s and bills only client rejections",
    async (status, kind, usage) => {
      const afterCall = vi.fn();
      await expect(
        new HttpDecisionProvider("typesafe", {
          apiKey: "fake-key",
          fetch: async () => new Response("", { status }),
          callObserver: { beforeCall: () => "reservation", afterCall },
        }).decide(request, context),
      ).rejects.toMatchObject({ kind });
      expect(afterCall).toHaveBeenCalledWith(
        "reservation",
        usage ? expect.objectContaining(usage) : null,
      );
    },
  );
});
