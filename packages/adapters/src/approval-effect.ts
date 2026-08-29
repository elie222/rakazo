import type { AgentToolExecutionResult } from "@rakazo/adapter-kit";

export type ApprovalPausedToolResult = AgentToolExecutionResult & { terminate: true };

export interface ApprovedEffectReplay {
  kind: string;
  request: unknown;
}

export interface ApprovedEffectReplayQueue {
  nextToolName(): string | undefined;
  take(toolName: string): Record<string, unknown> | undefined;
  assertDrained(): void;
}

export function createApprovedEffectReplayQueue(
  effects: readonly ApprovedEffectReplay[],
): ApprovedEffectReplayQueue {
  const pending = [...effects];

  return {
    nextToolName() {
      return pending[0]?.kind;
    },
    take(toolName) {
      const next = pending[0];
      if (!next || next.kind !== toolName) return undefined;
      pending.shift();
      const request = next.request;
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new TypeError(`Approved ${toolName} request is not a JSON object`);
      }
      return request as Record<string, unknown>;
    },
    assertDrained() {
      if (pending.length > 0) {
        throw new Error("Approved tool requests were not fully replayed");
      }
    },
  };
}

export function approvalPausedToolResult(): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for approval." }],
    details: { approval: "paused" },
    terminate: true,
  };
}

export function isToolPauseResult(result: unknown): result is ApprovalPausedToolResult {
  if (!result || typeof result !== "object") return false;
  const record = result as ApprovalPausedToolResult;
  if (record.kind !== "agent_tool_result") return false;
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  const pause = details as { approval?: unknown; secret?: unknown };
  return pause.approval === "paused" || pause.secret === "paused";
}

export function isApprovalPausedResult(result: unknown): result is ApprovalPausedToolResult {
  return isToolPauseResult(result);
}

export type DuplicateEffectGate =
  | { action: "execute" }
  | { action: "return"; result: unknown }
  | { action: "paused" }
  | { action: "uncertain"; toolName: string };

export type ExternalEffectStore = {
  externalEffect: {
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string };
    }) => Promise<{ count: number }>;
  };
};

export function resolveDuplicateEffectGate(
  effect: { status: string; result?: unknown },
  toolName: string,
): DuplicateEffectGate {
  if (effect.status === "completed") {
    return { action: "return", result: effect.result ?? { duplicate: true } };
  }
  if (effect.status === "denied") {
    return { action: "return", result: { error: "User denied this action." } };
  }
  if (effect.status === "executing") {
    return { action: "uncertain", toolName };
  }
  if (effect.status === "uncertain") {
    return { action: "return", result: effect.result ?? uncertainEffectResult(toolName) };
  }
  if (effect.status === "approved") {
    return { action: "execute" };
  }
  if (effect.status === "intended") {
    return { action: "paused" };
  }
  return { action: "uncertain", toolName };
}

export type UncertainEffectResult = { error: string; uncertain: true };

export function uncertainEffectResult(toolName: string): UncertainEffectResult {
  return {
    error: `The earlier ${toolName} execution was interrupted, so its outcome is unknown. It was not replayed to avoid a duplicate side effect. Verify the destination before proposing another action.`,
    uncertain: true,
  };
}

export async function settleUncertainEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: UncertainEffectResult };
      }) => Promise<{ count: number }>;
      findUnique: (args: {
        where: { id: string };
      }) => Promise<{ status: string; result?: unknown } | null>;
    };
  },
  effectId: string,
  toolName: string,
): Promise<unknown> {
  const result = uncertainEffectResult(toolName);
  const settled = await store.externalEffect.updateMany({
    where: { id: effectId, status: "executing" },
    data: { status: "uncertain", result },
  });
  if (settled.count === 1) return result;

  const current = await store.externalEffect.findUnique({ where: { id: effectId } });
  if (!current) return result;
  const gate = resolveDuplicateEffectGate(current, toolName);
  return gate.action === "return" ? gate.result : result;
}

export async function claimApprovedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "approved" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function claimIntendedEffect(
  store: ExternalEffectStore,
  effectId: string,
): Promise<boolean> {
  const claimed = await store.externalEffect.updateMany({
    where: { id: effectId, status: "intended" },
    data: { status: "executing" },
  });
  return claimed.count === 1;
}

export async function completeExternalEffect(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { status: string; result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  expectedStatus: "intended" | "executing",
  result: unknown,
): Promise<boolean> {
  const completed = await store.externalEffect.updateMany({
    where: { id: effectId, status: expectedStatus },
    data: { status: "completed", result: result as never },
  });
  return completed.count === 1;
}

export async function replaceCompletedExternalEffectResult(
  store: {
    externalEffect: {
      updateMany: (args: {
        where: { id: string; status: string };
        data: { result: never };
      }) => Promise<{ count: number }>;
    };
  },
  effectId: string,
  result: unknown,
): Promise<boolean> {
  const replaced = await store.externalEffect.updateMany({
    where: { id: effectId, status: "completed" },
    data: { result: result as never },
  });
  return replaced.count === 1;
}
