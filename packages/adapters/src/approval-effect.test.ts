import { approvalEffectKey } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it, vi } from "vitest";
import {
  approvalPausedToolResult,
  claimApprovedEffect,
  claimIntendedEffect,
  completeExternalEffect,
  isApprovalPausedResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
} from "./approval-effect.js";

describe("approvalEffectKey", () => {
  it("is stable across arg key order", () => {
    const left = approvalEffectKey("run-1", "destination.write", {
      collection: "notes",
      title: "Result",
      body: "hello",
    });
    const right = approvalEffectKey("run-1", "destination.write", {
      body: "hello",
      collection: "notes",
      title: "Result",
    });
    expect(left).toBe(right);
  });

  it("differs when args change", () => {
    const first = approvalEffectKey("run-1", "destination.write", { body: "one" });
    const second = approvalEffectKey("run-1", "destination.write", { body: "two" });
    expect(first).not.toBe(second);
  });
});

describe("resolveDuplicateEffectGate", () => {
  it("executes only after approval", () => {
    expect(resolveDuplicateEffectGate({ status: "approved" }, "archive_bot")).toEqual({
      action: "execute",
    });
  });

  it("returns denial without executing", () => {
    expect(resolveDuplicateEffectGate({ status: "denied" }, "destination.write")).toEqual({
      action: "return",
      result: { error: "User denied this action." },
    });
  });

  it("returns paused for intended effects instead of executing", () => {
    expect(resolveDuplicateEffectGate({ status: "intended" }, "archive_bot")).toEqual({
      action: "paused",
    });
    expect(resolveDuplicateEffectGate({ status: "intended" }, "delete_bot")).toEqual({
      action: "paused",
    });
  });

  it("fails closed for executing effects", () => {
    expect(resolveDuplicateEffectGate({ status: "executing" }, "destination.write")).toEqual({
      action: "uncertain",
      toolName: "destination.write",
    });
  });

  it("returns a previously reconciled uncertain result", () => {
    const result = { error: "outcome unknown", uncertain: true };
    expect(
      resolveDuplicateEffectGate({ status: "uncertain", result }, "destination.write"),
    ).toEqual({ action: "return", result });
  });
});

describe("claimApprovedEffect", () => {
  it("claims approved effects exactly once", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
    };

    await expect(claimApprovedEffect(store, "effect-1")).resolves.toBe(true);
    await expect(claimApprovedEffect(store, "effect-1")).resolves.toBe(false);
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "approved" },
      data: { status: "executing" },
    });
  });
});

describe("claimIntendedEffect", () => {
  it("claims intended effects exactly once", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
    };

    await expect(claimIntendedEffect(store, "effect-1")).resolves.toBe(true);
    await expect(claimIntendedEffect(store, "effect-1")).resolves.toBe(false);
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "intended" },
      data: { status: "executing" },
    });
  });
});

describe("completeExternalEffect", () => {
  it("does not let a stale worker overwrite a reconciled effect", async () => {
    const store = {
      externalEffect: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const result = { written: true };

    await expect(completeExternalEffect(store, "effect-1", "executing", result)).resolves.toBe(
      false,
    );
    expect(store.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: "executing" },
      data: { status: "completed", result },
    });
  });
});

describe("approved effect resume", () => {
  function createApprovedEffectStore(
    initialStatus: "approved" | "executing" | "completed" = "approved",
  ) {
    const effectId = "effect-1";
    let status: "approved" | "executing" | "completed" | "uncertain" = initialStatus;
    let destinationWrites = 0;
    const storedResult = { ok: true, written: true };
    let effectResult: unknown;
    const store = {
      externalEffect: {
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.id === effectId && where.status === "approved" && status === "approved") {
            status = data.status as typeof status;
            return { count: 1 };
          }
          if (where.id === effectId && where.status === "executing" && status === "executing") {
            status = data.status as typeof status;
            effectResult = data.result;
            return { count: 1 };
          }
          return { count: 0 };
        }),
        findUnique: vi.fn(async (_args: { where: { id: string } }) => ({
          id: effectId,
          status,
          result: status === "completed" ? storedResult : effectResult,
        })),
      },
    };

    const resumeApprovedTool = async (toolName: string, options?: { complete?: boolean }) => {
      const current = await store.externalEffect.findUnique({ where: { id: effectId } });
      const effect = current ?? { id: effectId, status, result: undefined as unknown };
      const gate = resolveDuplicateEffectGate(effect, toolName);
      if (gate.action === "return") return { executed: false, result: gate.result };
      if (gate.action === "uncertain") {
        return {
          executed: false,
          result: await settleUncertainEffect(store, effectId, toolName),
        };
      }
      if (!(await claimApprovedEffect(store, effectId))) {
        const current = await store.externalEffect.findUnique({ where: { id: effectId } });
        if (!current) {
          throw new Error(`tool ${toolName} has an earlier execution with an uncertain outcome`);
        }
        const retryGate = resolveDuplicateEffectGate(current, toolName);
        if (retryGate.action === "return") return { executed: false, result: retryGate.result };
        if (retryGate.action === "uncertain") {
          return {
            executed: false,
            result: await settleUncertainEffect(store, effectId, toolName),
          };
        }
        throw new Error(`tool ${toolName} has an earlier execution with an uncertain outcome`);
      }
      destinationWrites += 1;
      if (options?.complete !== false) {
        status = "completed";
      }
      return { executed: true, result: storedResult };
    };

    return {
      store,
      resumeApprovedTool,
      getDestinationWrites: () => destinationWrites,
      getStatus: () => status,
    };
  }

  it("records an unknown outcome without replaying after interruption", async () => {
    const harness = createApprovedEffectStore();

    const first = await harness.resumeApprovedTool("destination.write", { complete: false });
    const second = await harness.resumeApprovedTool("destination.write");

    expect(first).toEqual({ executed: true, result: { ok: true, written: true } });
    expect(second).toEqual({
      executed: false,
      result: expect.objectContaining({ uncertain: true }),
    });
    expect(harness.getStatus()).toBe("uncertain");
    expect(harness.getDestinationWrites()).toBe(1);
  });

  it("returns the stored result after the approved effect completed", async () => {
    const harness = createApprovedEffectStore();

    await harness.resumeApprovedTool("destination.write");
    const second = await harness.resumeApprovedTool("destination.write");

    expect(second).toEqual({ executed: false, result: { ok: true, written: true } });
    expect(harness.getDestinationWrites()).toBe(1);
  });
});

describe("approvalPausedToolResult", () => {
  it("returns a terminating agent tool result", () => {
    const paused = approvalPausedToolResult();
    expect(isApprovalPausedResult(paused)).toBe(true);
    expect(paused).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      details: { approval: "paused" },
    });
    expect(isApprovalPausedResult({ ok: true })).toBe(false);
  });
});
