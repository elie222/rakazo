import type * as Database from "@rakazo/db";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { operatorReviewObserver, requirePaidReviewAccount } from "./operator-review-usage.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Database>()),
  organizationForMember: vi.fn(async () => ({ organizationId: "organization-fixture" })),
}));

it.each([
  [null, "active", false],
  [new Date(0), "canceled", false],
  [new Date(0), "active", true],
  [new Date(0), "past_due", true],
])("requires paid history and billing access", async (paidAt, status, allowed) => {
  const prisma = {
    billingAccount: { findUnique: async () => ({ paidAt, status }) },
  } as unknown as PrismaClient;
  const result = requirePaidReviewAccount(prisma, { userId: "user", spaceId: "space" });
  if (allowed) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow("paid account");
});

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
