import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelCreditReconciler } from "./model-credit-reconciler.js";

function harness(call: Record<string, unknown>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    modelCreditLot: { findMany: vi.fn().mockResolvedValue([]) },
    modelCreditEntry: { findMany: vi.fn().mockResolvedValue([call]), updateMany },
    modelCreditAccount: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  return { prisma, updateMany };
}

const baseCall = {
  id: "entry-1",
  callId: "call-1",
  userId: "user-1",
  spaceId: "space-1",
  runId: "run-1",
  provider: "fake",
  model: "fake-model",
  pending: true,
  usage: null,
  providerRequestId: null,
  auditRevision: 0,
};

describe("model credit reconciler", () => {
  afterEach(() => {
    installLogger(createLogger({ service: "rakazo-worker", level: "off", sinks: [] }));
  });

  it("flags an unsettled hold for review with the reason it could not settle", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const { prisma, updateMany } = harness({ ...baseCall, reconciliationAttempts: 5 });

    await createModelCreditReconciler({ prisma, now: () => new Date(0) })();

    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "entry-1", reconciliationState: "pending" },
      data: { reconciliationState: "needs_review", nextReconcileAt: null },
    });
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Model credit hold requires review",
        callId: "call-1",
        reason: "usage unavailable",
        provider: "fake",
        model: "fake-model",
        attempts: 6,
        hasProviderRequestId: false,
        canLookUpUsage: false,
      }),
    );
  });

  it("keeps the failure reason on each attempt that could not verify a call", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const { prisma } = harness({ ...baseCall, model: null, reconciliationAttempts: 0 });

    await createModelCreditReconciler({ prisma, now: () => new Date(0) })();

    expect(sink.events).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "Model credit reconciliation could not verify a call",
        reason: "Legacy reservation requires manual attribution",
      }),
    ]);
  });
});
