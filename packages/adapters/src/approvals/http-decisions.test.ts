import type { AdapterContext, DecisionRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { estimateTextTokens } from "../runtime/context/context-selection.js";
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
    expect(beforeCall).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: null }));
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
  it("keeps unknown provider usage unpriced for customer holds", async () => {
    const onUsage = vi.fn();
    const afterCall = vi.fn();
    const body = await response().json();
    delete body.usage;
    const result = await new HttpDecisionProvider(provider, {
      apiKey: "fake-key",
      fetch: async () => Response.json(body),
      onUsage,
      callObserver: { beforeCall: () => "reservation", afterCall },
    }).decide(request, context);
    expect(result.usage?.costUsd).toBeNull();
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({ costUsd: null }),
    );
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: null }));
  });
  it("reports the observer tariff even when request-ID persistence fails", async () => {
    const onUsage = vi.fn();
    const result = await new HttpDecisionProvider(provider, {
      apiKey: "fake-key",
      fetch: async () => response(),
      onUsage,
      callObserver: {
        beforeCall: () => "reservation",
        onRequestId: async () => {
          throw new Error("Request identity storage unavailable");
        },
        afterCall: (_id, usage) => ({ ...usage!, costUsd: 0.25, costSource: "deployment-tariff" }),
      },
    }).decide(request, context);
    expect(result.usage).toMatchObject({ costUsd: 0.25, costSource: "deployment-tariff" });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining(result.usage));
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
  it("keeps a full prompt count for an aborted request", async () => {
    const afterCall = vi.fn();
    const controller = new AbortController();
    await expect(
      new HttpDecisionProvider("openrouter", {
        apiKey: "fake-key",
        fetch: async () => {
          controller.abort();
          throw new Error("aborted");
        },
        callObserver: { beforeCall: () => "reservation", afterCall },
      }).decide(request, { ...context, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        operationKind: "setup",
        countedTokens: {
          inputTokens: expect.any(Number),
          outputTokens: 0,
          ifStopped: { inputTokens: estimateTextTokens(JSON.stringify(request)), outputTokens: 0 },
        },
      }),
    );
  });

  it("keeps a prompt count for a response without usage", async () => {
    const afterCall = vi.fn();
    const onUsage = vi.fn();
    const result = await new HttpDecisionProvider("openrouter", {
      apiKey: "fake-key",
      onUsage,
      fetch: async () =>
        Response.json({
          answers: { decision: { type: "choice", choice: "pass", confidence: 0.9 } },
        }),
      callObserver: { beforeCall: () => "reservation", afterCall },
    }).decide(request, context);
    expect(result.usage).toEqual(afterCall.mock.calls[0]?.[1]);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining(result.usage));
    expect(result.usage).toMatchObject({
      pricingVersion: "decision-pricing-2026-11-17",
      pricingSnapshot: { estimatedInputTokens: estimateTextTokens(JSON.stringify(request)) },
    });
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({
        costUsd: null,
        costSource: null,
        pricingSnapshot: expect.objectContaining({
          input: expect.any(Number),
          source: expect.any(String),
        }),
        countedTokens: { inputTokens: expect.any(Number), outputTokens: 0 },
      }),
    );
  });

  it("retains unknown billing when a dispatched request loses its response", async () => {
    const afterCall = vi.fn();
    await expect(
      new HttpDecisionProvider("typesafe", {
        apiKey: "fake-key",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        callObserver: { beforeCall: () => "reservation", afterCall },
      }).decide(request, context),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(afterCall).toHaveBeenCalledWith(
      "reservation",
      expect.objectContaining({ costUsd: null, usageSource: "unavailable" }),
    );
  });

  it("refuses a blank API key before any request", () => {
    expect(() => new HttpDecisionProvider("typesafe", { apiKey: " " })).toThrow(
      expect.objectContaining({ kind: "authentication" }),
    );
  });

  it.each([
    [422, "invalid", { costUsd: 0, usageSource: "provider-rejected" }],
    [429, "busy", { costUsd: 0, usageSource: "provider-rejected" }],
    [
      503,
      "unavailable",
      { costUsd: null, countedTokens: { inputTokens: expect.any(Number), outputTokens: 0 } },
    ],
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
      expect(afterCall).toHaveBeenCalledWith("reservation", expect.objectContaining(usage));
    },
  );
});

it("retains header request IDs and estimated pricing when a response is malformed", async () => {
  const afterCall = vi.fn();
  const onRequestId = vi.fn();
  await expect(
    new HttpDecisionProvider("openrouter", {
      apiKey: "fake-key",
      fetch: async () =>
        new Response("invalid-json", { headers: { "x-request-id": "request-fixture" } }),
      callObserver: { beforeCall: () => "call", onRequestId, afterCall },
    }).decide(request, context),
  ).rejects.toMatchObject({ kind: "unavailable" });
  expect(onRequestId).toHaveBeenCalledWith("call", "request-fixture");
  expect(afterCall).toHaveBeenCalledWith(
    "call",
    expect.objectContaining({
      providerRequestId: "request-fixture",
      costSource: null,
      pricingVersion: "decision-pricing-2026-11-17",
      costUsd: null,
    }),
  );
});

it.each(["fake-request", "", "   ", undefined])(
  "keeps a usable billing ID when the body supplies %j",
  async (bodyId) => {
    const onRequestId = vi.fn();
    const afterCall = vi.fn();
    const result = await new HttpDecisionProvider("openrouter", {
      apiKey: "fake-key",
      fetch: async () =>
        Response.json(
          { ...(await response().json()), id: bodyId },
          {
            headers: { "x-request-id": "transport-fixture" },
          },
        ),
      callObserver: { beforeCall: () => "call", onRequestId, afterCall },
    }).decide(request, context);
    const expected = bodyId?.trim() || "transport-fixture";
    expect(onRequestId.mock.calls).toEqual([["call", expected]]);
    expect(result.usage?.providerRequestId).toBe(expected);
    expect(afterCall).toHaveBeenCalledWith("call", result.usage);
  },
);

it.each([false, true])(
  "records decision usage when request-ID persistence fails (synchronous=%s)",
  async (synchronous) => {
    const onUsage = vi.fn();
    const afterCall = vi.fn();
    const provider = new HttpDecisionProvider("openrouter", {
      apiKey: "fake-key",
      fetch: async () => response(),
      onUsage,
      callObserver: {
        beforeCall: () => "hold",
        afterCall,
        onRequestId: () => {
          const error = new Error("Request identity storage unavailable");
          if (synchronous) throw error;
          return Promise.reject(error);
        },
      },
    });
    const result = await provider.decide(request, context);
    expect(result.answers.decision?.choice).toBe("pass");
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0.0000042, providerRequestId: "fake-request" }),
    );
    expect(afterCall).toHaveBeenCalledWith("hold", result.usage);
  },
);

it("releases an observer intent when cancellation happens before dispatch", async () => {
  const controller = new AbortController();
  const afterCall = vi.fn();
  const fetchMock = vi.fn();
  await expect(
    new HttpDecisionProvider("typesafe", {
      apiKey: "fake-key",
      fetch: fetchMock,
      callObserver: {
        beforeCall: () => {
          controller.abort();
          return "intent";
        },
        afterCall,
      },
    }).decide(request, { ...context, signal: controller.signal }),
  ).rejects.toMatchObject({ kind: "unavailable" });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(afterCall).toHaveBeenCalledWith("intent", null);
});
