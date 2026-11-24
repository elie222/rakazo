import { UNATTENDED_APPROVAL_EXPIRE_AFTER_MS } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { expireApprovalCard, scheduleApprovalExpiry } from "./approval-expiry.js";

const card = (status: "pending" | "answered" = "pending") => ({
  id: "message-1",
  threadId: "thread-1",
  blocks: [
    {
      kind: "ask",
      text: "Send it?",
      approvalEffectId: "effect-1",
      status,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  ],
});

function deps(runStatus: string, messages = [card()]) {
  const answerRunInput = vi.fn(async () => true);
  const enqueue = vi.fn(async () => undefined);
  return {
    answerRunInput,
    enqueue,
    deps: {
      prisma: {
        run: {
          findUnique: vi.fn(async () => ({
            status: runStatus,
            spaceId: "space-1",
            userId: "user-1",
          })),
        },
        message: { findMany: vi.fn(async () => messages) },
      },
      events: { answerRunInput },
      jobs: { enqueue },
    } as never,
  };
}

describe("scheduleApprovalExpiry", () => {
  it("schedules the end of a card an unattended run posts", async () => {
    const enqueueIn = vi.fn(async () => undefined);
    await scheduleApprovalExpiry(
      { enqueueIn } as never,
      "tx" as never,
      { trigger: "routine", runId: "run-1", effectId: "effect-1" },
      1_000,
    );
    expect(enqueueIn).toHaveBeenCalledExactlyOnceWith("tx", {
      name: "approval.expire",
      payload: { runId: "run-1", effectId: "effect-1" },
      availableAt: new Date(1_000 + UNATTENDED_APPROVAL_EXPIRE_AFTER_MS),
      replaceKey: "approval.expire:effect-1",
    });
  });

  it("waits as long as the deployment configures", async () => {
    vi.stubEnv("UNATTENDED_APPROVAL_EXPIRE_AFTER_MS", "7200000");
    const enqueueIn = vi.fn(async () => undefined);
    await scheduleApprovalExpiry(
      { enqueueIn } as never,
      "tx" as never,
      { trigger: "routine", runId: "run-1", effectId: "effect-1" },
      1_000,
    );
    expect(enqueueIn).toHaveBeenCalledExactlyOnceWith("tx", {
      name: "approval.expire",
      payload: { runId: "run-1", effectId: "effect-1" },
      availableAt: new Date(1_000 + 7_200_000),
      replaceKey: "approval.expire:effect-1",
    });
    vi.unstubAllEnvs();
  });

  it("keeps the default when the configured value is not a usable span", async () => {
    vi.stubEnv("UNATTENDED_APPROVAL_EXPIRE_AFTER_MS", "soon");
    const enqueueIn = vi.fn(async () => undefined);
    await scheduleApprovalExpiry(
      { enqueueIn } as never,
      "tx" as never,
      { trigger: "routine", runId: "run-1", effectId: "effect-1" },
      1_000,
    );
    expect(enqueueIn).toHaveBeenCalledExactlyOnceWith("tx", {
      name: "approval.expire",
      payload: { runId: "run-1", effectId: "effect-1" },
      availableAt: new Date(1_000 + UNATTENDED_APPROVAL_EXPIRE_AFTER_MS),
      replaceKey: "approval.expire:effect-1",
    });
    vi.unstubAllEnvs();
  });

  it("leaves a card in a chat someone is in open", async () => {
    const enqueueIn = vi.fn(async () => undefined);
    await scheduleApprovalExpiry({ enqueueIn } as never, "tx" as never, {
      trigger: "user",
      runId: "run-1",
      effectId: "effect-1",
    });
    expect(enqueueIn).not.toHaveBeenCalled();
  });
});

describe("expireApprovalCard", () => {
  it("answers a card still waiting as expired and wakes the run", async () => {
    const { deps: d, answerRunInput, enqueue } = deps("waiting_input");
    await expireApprovalCard(d, { runId: "run-1", effectId: "effect-1" });
    expect(answerRunInput).toHaveBeenCalledExactlyOnceWith({
      spaceId: "space-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-1",
      answeredByUserId: "user-1",
      answer: "deny",
      expired: true,
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does nothing once the card was answered or the run moved on", async () => {
    for (const [status, messages] of [
      ["waiting_input", [card("answered")]],
      ["running", [card()]],
    ] as const) {
      const { deps: d, answerRunInput, enqueue } = deps(status, [...messages]);
      await expireApprovalCard(d, { runId: "run-1", effectId: "effect-1" });
      expect(answerRunInput).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    }
  });
});
