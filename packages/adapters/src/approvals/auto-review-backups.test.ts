import type { AutoReviewResult } from "@rakazo/adapter-kit";
import { DecisionProviderError } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostedModelCreditsRequiredError,
  ModelCreditAccountUnavailableError,
} from "../models/credits/model-credit-observer.js";
import {
  ModelConnectionGoneError,
  UnavailableModelForAuthError,
} from "../models/model-selection.js";
import { EncryptedSecretStore } from "../secrets/secrets.js";
import type { AutoReviewCandidate } from "./auto-review-backups.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import type { AutoReviewFailureCode } from "./auto-review-failures.js";
import {
  AUTO_REVIEW_FAILURE_REASONS,
  AutoReviewSetupError,
  CheckerConnectionUnavailableError,
} from "./auto-review-failures.js";

const candidates: AutoReviewCandidate[] = [
  { provider: "one", model: "first", role: "member" },
  { provider: "two", model: "second", role: "backup" },
];

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("approval model backups", () => {
  it.each(["pass", "ask"] as const)("never retries a deliberate %s", async (decision) => {
    const review = vi.fn(async () => ({ decision, model: "first" }));
    expect(
      (await reviewWithBackups(candidates, review, new AbortController().signal)).decision,
    ).toBe(decision);
    expect(review).toHaveBeenCalledTimes(1);
  });
  it("tries backups in order for errors and deduplicates candidates", async () => {
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new Error("fake secret"))
      .mockResolvedValue({ decision: "pass", model: "second" });
    expect(
      (
        await reviewWithBackups(
          [candidates[0]!, ...candidates],
          review,
          new AbortController().signal,
        )
      ).decision,
    ).toBe("pass");
    expect(review.mock.calls).toHaveLength(2);
    expect(review).toHaveBeenNthCalledWith(2, candidates[1]);
  });
  it("tries the same model on another account's connection", async () => {
    const personal: AutoReviewCandidate = {
      provider: "openai-codex",
      model: "gpt-5",
      credentialId: "personal",
      role: "member",
    };
    const work: AutoReviewCandidate = { ...personal, credentialId: "work", role: "backup" };
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new Error("usage limit"))
      .mockResolvedValue({ decision: "pass", model: "gpt-5" });
    expect(
      (await reviewWithBackups([personal, work], review, new AbortController().signal)).decision,
    ).toBe("pass");
    expect(review).toHaveBeenNthCalledWith(2, work);
  });
  it("fails closed when all checkers fail and respects cancellation", async () => {
    const review = vi.fn(async () => {
      throw new Error("fake secret");
    });
    const result = await reviewWithBackups(candidates, review, new AbortController().signal);
    expect(result.decision).toBe("error");
    expect(JSON.stringify(result)).not.toContain("fake secret");
    review.mockClear();
    await reviewWithBackups(candidates, review, AbortSignal.abort());
    expect(review).not.toHaveBeenCalled();
  });
  it("tries the included reviewer after a member's choice of the same model", async () => {
    const review = vi
      .fn<(candidate: AutoReviewCandidate) => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new CheckerConnectionUnavailableError())
      .mockResolvedValue({ decision: "pass", model: "included" });
    const member: AutoReviewCandidate = { provider: "fixture", model: "checker", role: "member" };
    const included: AutoReviewCandidate = { ...member, included: true, role: "default" };
    const result = await reviewWithBackups(
      [member, included],
      review,
      new AbortController().signal,
    );
    expect(result.decision).toBe("pass");
    expect(review).toHaveBeenNthCalledWith(2, included);
  });
  it("keeps the member's failure cause when the included reviewer also fails", async () => {
    const review = vi
      .fn<() => Promise<AutoReviewResult>>()
      .mockRejectedValueOnce(new HostedModelCreditsRequiredError("fake detail"))
      .mockResolvedValue({ decision: "error", model: "included", reason: "Checker timed out." });
    const result = await reviewWithBackups(
      [
        { provider: "fixture", model: "checker", role: "member" },
        { provider: "fixture", model: "checker", included: true, role: "default" },
      ],
      review,
      new AbortController().signal,
    );
    expect(review).toHaveBeenCalledTimes(2);
    expect(result.reason).toBe(AUTO_REVIEW_FAILURE_REASONS.credits_required);
  });
  it("logs the included fallback apart from the default reviewer", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    await reviewWithBackups(
      [{ provider: "fixture", model: "checker", included: true, role: "default" }],
      async () => {
        throw new Error("fake detail");
      },
      new AbortController().signal,
    );
    expect(sink.events[0]?.["auto_review.role"]).toBe("included");
  });
  it("keeps a deliberate ask from the first reviewer away from the included reviewer", async () => {
    const review = vi.fn(async () => ({ decision: "ask" as const, model: "member" }));
    await reviewWithBackups(
      [
        { provider: "fixture", model: "checker", role: "member" },
        { provider: "fixture", model: "checker", included: true, role: "default" },
      ],
      review,
      new AbortController().signal,
    );
    expect(review).toHaveBeenCalledOnce();
  });
});

async function decryptFailure(): Promise<unknown> {
  const store = new EncryptedSecretStore("fake-encryption-key");
  const record = await store.put("fake-model-key", {
    operationId: "op",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  });
  return store.load(record.ciphertext, "another-row").catch((error: unknown) => error);
}

describe("reviewer failure reasons", () => {
  it("logs nothing when the run is cancelled mid-review", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const controller = new AbortController();
    const review = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await reviewWithBackups(candidates, review, controller.signal);
    expect(review).toHaveBeenCalledOnce();
    expect(sink.events).toEqual([]);
  });

  it.each<[AutoReviewFailureCode, () => unknown]>([
    ["credits_required", () => new HostedModelCreditsRequiredError("fake detail")],
    ["credits_required", () => new ModelCreditAccountUnavailableError()],
    ["connection_unavailable", () => new CheckerConnectionUnavailableError()],
    ["connection_unavailable", () => new ModelConnectionGoneError("fake detail")],
    ["model_unavailable", () => new UnavailableModelForAuthError("fake detail")],
    ["decision_auth", () => new DecisionProviderError("authentication")],
    ["provider_construction", () => new AutoReviewSetupError("fake detail")],
    ["decrypt", decryptFailure],
    ["unexpected", () => new Error("fake detail")],
  ])("stores %s and logs only its cause", async (code, makeError) => {
    const error = await makeError();
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const result = await reviewWithBackups(
      [{ provider: "fixture", model: "checker", credentialId: "fake-id", role: "member" }],
      async () => {
        throw error;
      },
      new AbortController().signal,
    );
    expect(result).toEqual({
      decision: "error",
      model: "fixture/checker",
      reason: AUTO_REVIEW_FAILURE_REASONS[code],
    });
    expect(sink.events).toHaveLength(1);
    const { timestamp: _timestamp, ...event } = sink.events[0]!;
    expect(event).toEqual({
      level: "warn",
      message: "auto_review.checker_failed",
      "service.name": "test",
      "auto_review.reason": code,
      "auto_review.provider": "fixture",
      "auto_review.role": "member",
      "error.name": (error as Error).name,
    });
    expect(JSON.stringify(sink.events)).not.toMatch(/fake|checker connection/i);
  });
});

it("keeps included and explicit credit-funded checkers as distinct fallback choices", async () => {
  const review = vi
    .fn()
    .mockResolvedValueOnce({ decision: "error", model: "included", reason: "unavailable" })
    .mockResolvedValueOnce({ decision: "pass", model: "member-funded", reason: "within request" });
  const result = await reviewWithBackups(
    [
      { provider: "fixture", model: "checker", role: "default" },
      {
        provider: "fixture",
        model: "checker",
        creditOfferingId: "selected-offering",
        role: "backup",
      },
    ],
    review,
    new AbortController().signal,
  );
  expect(review).toHaveBeenCalledTimes(2);
  expect(result.decision).toBe("pass");
});
