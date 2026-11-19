import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { operatorReviewObserver } from "./operator-review-usage.js";

it("records intent, request id and final evidence without touching purchased credits", async () => {
  const createMany = vi.fn();
  const updateMany = vi.fn();
  const debit = vi.fn(() => {
    throw new Error("must not debit");
  });
  const tx = { usageRecord: { createMany, updateMany }, modelCreditEntry: { findUnique: debit } };
  const prisma = {
    $transaction: async (work: (tx: unknown) => unknown) => work(tx),
  } as unknown as PrismaClient;
  const observer = operatorReviewObserver(prisma, {
    spaceId: "space",
    userId: "user",
    runId: "run",
    botId: "bot",
    operationKind: "setup",
  });
  const id = await observer.beforeCall({
    callId: "call",
    provider: "fixture",
    modelId: "checker",
    inputTokensEstimate: 100,
    maxOutputTokens: 0,
  });
  expect(createMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: [
        expect.objectContaining({
          fundingSource: "operator",
          inputTokens: null,
          costUsd: null,
          usageSource: "dispatch-pending",
          runId: "run",
          botId: "bot",
        }),
      ],
    }),
  );
  await observer.onRequestId!(id, "request-fixture");
  await observer.afterCall(id, {
    inputTokens: 100,
    outputTokens: 0,
    costUsd: 0.001,
    costSource: "provider-reported",
    pricingVersion: "fixture-v1",
    pricingSnapshot: { input: 10 },
    usageSource: "response",
  });
  expect(updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        providerRequestId: "request-fixture",
        costUsd: 0.001,
        costSource: "provider-reported",
        pricingVersion: "fixture-v1",
      }),
    }),
  );
  expect(debit).not.toHaveBeenCalled();
});

it("estimates an unknown operator expense without changing provider usage or customer settlement", async () => {
  const createMany = vi.fn();
  const updateMany = vi.fn();
  const prisma = {
    $transaction: async (work: (tx: unknown) => unknown) =>
      work({ usageRecord: { createMany, updateMany } }),
  } as unknown as PrismaClient;
  const observer = operatorReviewObserver(prisma, { userId: "user", spaceId: "space" });
  const id = await observer.beforeCall({
    callId: "operator-call",
    provider: "openrouter",
    modelId: "typesafe/jev-1.14",
    inputTokensEstimate: 1000,
    maxOutputTokens: 0,
  });
  const usage = {
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    usageSource: "unavailable",
    pricingSnapshot: { estimatedInputTokens: 250 },
  };
  await observer.afterCall(id, usage);
  expect(usage.costUsd).toBeNull();
  expect(updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        costUsd: 0.0000105,
        costSource: "request-token-estimate",
        inputTokens: null,
        pricingSnapshot: expect.objectContaining({ estimatedInputTokens: 250 }),
      }),
    }),
  );
});
