import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { recordUsage } from "./usage.js";

describe("usage ledger", () => {
  it("retains charged usage arriving after its run was deleted", async () => {
    const createMany = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2003" })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = { usageRecord: { createMany } } as unknown as Pick<PrismaClient, "usageRecord">;
    await recordUsage(
      prisma,
      {
        type: "usage",
        provider: "fixture",
        model: "test",
        callId: "late-call",
        inputTokens: 10,
        outputTokens: 2,
      },
      { spaceId: "space-fixture", userId: "user-fixture", runId: "deleted-run" },
    );
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[1]?.[0]).toMatchObject({
      data: [expect.objectContaining({ runId: null, parentRunId: "deleted-run", inputTokens: 10 })],
    });
  });
  it("persists every reported bucket and durable operation attribution idempotently", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn();
    const prisma = { usageRecord: { createMany, create } } as unknown as Pick<
      PrismaClient,
      "usageRecord"
    >;
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "test",
      callId: "call-fixture",
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reasoningTokens: 10,
      totalTokens: 130,
      costUsd: 0.001,
      costSource: "fixture",
      pricingVersion: "v1",
      operationKind: "subagent" as const,
      agentId: "agent-fixture",
    };
    await recordUsage(prisma, event, {
      spaceId: "space-fixture",
      userId: "user-fixture",
      botId: "bot-fixture",
      parentRunId: "run-fixture",
      operationId: "operation-fixture",
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          callId: event.callId,
          inputTokens: 60,
          outputTokens: 30,
          cacheReadTokens: 40,
          reasoningTokens: 10,
          operationKind: "subagent",
          agentId: "agent-fixture",
          parentRunId: "run-fixture",
          cacheWriteTokens: 0,
        }),
      ],
      skipDuplicates: true,
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("keeps unknown usage null and never invents a foreground run for background work", async () => {
    const create = vi.fn(async (args) => args.data);
    const prisma = { usageRecord: { create } } as unknown as Pick<PrismaClient, "usageRecord">;
    await recordUsage(
      prisma,
      { type: "usage", provider: "fixture", model: "test", inputTokens: null, outputTokens: null },
      {
        spaceId: "space-fixture",
        userId: "user-fixture",
        operationKind: "compaction",
        operationId: "job-fixture",
      },
    );
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      operationKind: "compaction",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      costUsd: null,
    });
    expect(data).not.toHaveProperty("runId");
  });
});
