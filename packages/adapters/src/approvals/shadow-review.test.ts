import type { AdapterContext, AutoReviewRequest, DecisionProvider } from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import { deferred, flush } from "@rakazo/core/test-async";
import { installAuditEventStore } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { ShadowedReview } from "./shadow-review.js";
import {
  autoReviewShadowModel,
  recordShadowReview,
  ShadowedAutoReviewProvider,
} from "./shadow-review.js";

const request: AutoReviewRequest = {
  toolName: "fixture_action",
  connectorKind: "fixture",
  args: {},
  userTask: "Review this action",
  botDescription: "Fixture bot",
  matchingRules: [],
};
const calibration = { confidenceScale: "linear" as const, minPassProbability: 0.75 };

function context(signal = new AbortController().signal): AdapterContext {
  return { operationId: "review", traceId: "review", spaceId: "space", userId: "user", signal };
}

function answering(choice: "pass" | "ask", confidence: number): DecisionProvider {
  return {
    decide: async ({ model }) => ({
      model,
      answers: { decision: { type: "choice", choice, confidence } },
    }),
  };
}

function reviewer(provider: DecisionProvider, model: string, timeoutMs?: number) {
  return new DecisionAutoReviewProvider({
    provider,
    providerId: "decisions",
    model,
    calibration,
    timeoutMs,
  });
}

it.each([
  ["ask", "pass"],
  ["pass", "ask"],
] as const)(
  "decides %s as the deciding reviewer does when the trial model says %s, without waiting for it",
  async (decided, trial) => {
    const held = deferred();
    const record = vi.fn(async (_review: ShadowedReview) => undefined);
    const provider = new ShadowedAutoReviewProvider({
      primary: reviewer(answering(decided, 0.9), "primary"),
      shadow: reviewer(
        {
          decide: async (input, adapterContext) => {
            await held.promise;
            return answering(trial, 0.9).decide(input, adapterContext);
          },
        },
        "trial",
      ),
      record,
    });
    await expect(provider.review(request, context())).resolves.toEqual({
      decision: decided,
      model: "decisions/primary",
    });
    await flush();
    expect(record).not.toHaveBeenCalled();
    held.resolve();
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    const review = record.mock.calls[0]![0];
    expect(review.primary).toMatchObject({
      result: { decision: decided, model: "decisions/primary" },
      passProbability: decided === "pass" ? 0.95 : expect.closeTo(0.05),
      latencyMs: expect.any(Number),
    });
    expect(review.shadow).toMatchObject({
      result: { decision: trial, model: "decisions/trial" },
      passProbability: trial === "pass" ? 0.95 : expect.closeTo(0.05),
      latencyMs: expect.any(Number),
    });
  },
);

it.each([
  ["fails", { decide: async () => Promise.reject(new DecisionProviderError("unavailable")) }],
  [
    "times out",
    {
      decide: (_input, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    } satisfies DecisionProvider,
  ],
] as const)("records a trial model that %s as an error and decides as before", async (_, trial) => {
  const record = vi.fn(async (_review: ShadowedReview) => undefined);
  const provider = new ShadowedAutoReviewProvider({
    primary: reviewer(answering("pass", 0.9), "primary"),
    shadow: reviewer(trial, "trial", 1),
    record,
  });
  await expect(provider.review(request, context())).resolves.toMatchObject({ decision: "pass" });
  await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
  expect(record.mock.calls[0]![0].shadow.result).toMatchObject({
    decision: "error",
    reason: expect.any(String),
  });
});

it("keeps a failed record from reaching the review", async () => {
  const provider = new ShadowedAutoReviewProvider({
    primary: reviewer(answering("pass", 0.9), "primary"),
    shadow: reviewer(answering("pass", 0.9), "trial"),
    record: async () => Promise.reject(new Error("audit store down")),
  });
  await expect(provider.review(request, context())).resolves.toMatchObject({ decision: "pass" });
  await flush();
});

it("records nothing for a cancelled run", async () => {
  const held = deferred();
  const controller = new AbortController();
  const record = vi.fn(async (_review: ShadowedReview) => undefined);
  const provider = new ShadowedAutoReviewProvider({
    primary: reviewer(answering("pass", 0.9), "primary"),
    shadow: reviewer(
      {
        decide: async (input, adapterContext) => {
          await held.promise;
          return answering("pass", 0.9).decide(input, adapterContext);
        },
      },
      "trial",
    ),
    record,
  });
  await provider.review(request, context(controller.signal));
  controller.abort();
  held.resolve();
  await flush();
  expect(record).not.toHaveBeenCalled();
});

const openRouterDecisionModel = decisionModel("openrouter", "typesafe/jev-1.14")!;
const openRouterMicrosoftDecisionModel = decisionModel(
  "openrouter",
  "microsoft/microsoft-decision-1.1",
)!;
const env = {
  OPENROUTER_API_KEY: "fake-operator-key",
  RAKAZO_AUTO_REVIEW_SHADOW_MODEL: openRouterMicrosoftDecisionModel.id,
};

it("names a trial model only when the deployment sets one of the same host's other models", () => {
  expect(autoReviewShadowModel(openRouterDecisionModel, env)).toBe(
    openRouterMicrosoftDecisionModel,
  );
  expect(
    autoReviewShadowModel(openRouterDecisionModel, { OPENROUTER_API_KEY: "fake" }),
  ).toBeUndefined();
  for (const id of [openRouterDecisionModel.id, "jev-latest", "unknown/model"]) {
    expect(
      autoReviewShadowModel(openRouterDecisionModel, {
        ...env,
        RAKAZO_AUTO_REVIEW_SHADOW_MODEL: id,
      }),
    ).toBeUndefined();
  }
});

it("samples reviews at the deployment's rate, and runs none at a rate it cannot read", () => {
  const at = (rate: string, draw: number) =>
    autoReviewShadowModel(
      openRouterDecisionModel,
      { ...env, RAKAZO_AUTO_REVIEW_SHADOW_SAMPLE_RATE: rate },
      () => draw,
    );
  expect(at("0.5", 0.4)).toBeDefined();
  expect(at("0.5", 0.6)).toBeUndefined();
  for (const rate of ["0", "5", "10%", "-1"]) expect(at(rate, 0)).toBeUndefined();
});

it("records why a trial failed beside the deciding reviewer's verdict", async () => {
  const createMany = vi.fn();
  installAuditEventStore({
    auditEvent: { createMany },
    space: { findUnique: async () => ({ organizationId: "organization", name: "Space" }) },
    user: { findUnique: async () => null },
    member: { findMany: async () => [] },
  } as never);
  try {
    await recordShadowReview(
      { spaceId: "space", runId: "run", threadId: "thread", effectId: "effect" },
      {
        request,
        primary: { result: { decision: "pass", model: "decisions/primary" }, latencyMs: 40 },
        shadow: {
          result: { decision: "error", model: "decisions/trial", reason: "Checker is busy." },
          latencyMs: 90,
        },
      },
    );
  } finally {
    installAuditEventStore(undefined);
  }
  expect(createMany.mock.calls[0]?.[0].data).toEqual([
    expect.objectContaining({
      action: "approval.shadow_reviewed",
      outcome: "failure",
      metadata: expect.objectContaining({
        effectId: "effect",
        decision: "pass",
        shadowDecision: "error",
        shadowReason: "Checker is busy.",
      }),
    }),
  ]);
});
