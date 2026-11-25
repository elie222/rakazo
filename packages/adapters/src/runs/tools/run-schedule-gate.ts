import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import { argumentGiven } from "../../bots/update-bot-patch.js";
import type { RunContext } from "../assembly/run-context.js";
import {
  nextMutatingEffectOccurrence,
  peekMutatingEffectOccurrence,
} from "../assembly/run-context.js";
import {
  completeIntendedEffect,
  findRecordedEffect,
  updateIntendedEffectRequest,
} from "../lifecycle/run-effects.js";
import { refusal } from "../turn/tool-refusal.js";
import {
  intendedScheduleGateAction,
  prepareScheduleCancelApproval,
  storedRequestObject,
} from "./run-schedule-approval.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareScheduleUpdateApproval } from "./run-tool-request.js";
import { scheduleCancelPreview } from "./run-tools-tasks.js";

/**
 * Validate a gated `schedule_update` or `schedule_cancel` call before recording or reposting an
 * approval card: pin its baseline or `routineId` on a fresh call, or verify and fence updates on
 * an existing `intended` receipt during recovery.
 */
export async function prepareScheduleGateCall(
  ctx: RunContext,
  request: ToolRequest,
  input: {
    name: "schedule_update" | "schedule_cancel";
    args: Record<string, unknown>;
    effectRequest: unknown;
    keyArgs: Record<string, unknown>;
    usesApprovalKey: boolean;
    pinnedEffectKey: string | undefined;
  },
): Promise<
  | { refused: unknown }
  | {
      args: Record<string, unknown>;
      effectRequest: unknown;
      pinnedEffectKey: string | undefined;
    }
> {
  const { deps, run, runId } = ctx;
  const { executionId, replayEffectToolName } = request;
  let { args, effectRequest, pinnedEffectKey } = input;
  const { name, keyArgs, usesApprovalKey } = input;

  const peeked = peekMutatingEffectOccurrence(
    ctx,
    replayEffectToolName,
    keyArgs,
    executionId,
    pinnedEffectKey,
  );
  const candidateKey =
    pinnedEffectKey ??
    (usesApprovalKey && peeked === 0
      ? approvalEffectKey(runId, replayEffectToolName, keyArgs)
      : toolEffectIdempotencyKey(runId, replayEffectToolName, keyArgs, peeked));
  const existing = await findRecordedEffect(
    deps,
    run,
    replayEffectToolName,
    candidateKey,
    effectRequest,
    executionId,
    ctx.state.effects.consumedIds,
    ctx.state.effects.counts,
  );
  if (existing) {
    pinnedEffectKey = existing.matchedKey;
    if (
      existing.effect.status === "intended" &&
      !intendedScheduleGateAction(name, existing.effect)
    ) {
      const current = await deps.prisma.run.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (current?.status !== "waiting_input") {
        const stored = storedRequestObject(existing.effect.request);
        if (name === "schedule_update") {
          const refused = await prepareScheduleUpdateApproval(ctx, request, stored?.expected);
          if (refused) {
            if (await completeIntendedEffect(deps, runId, existing.effect.id, refused)) {
              nextMutatingEffectOccurrence(
                ctx,
                replayEffectToolName,
                keyArgs,
                executionId,
                pinnedEffectKey,
              );
              ctx.state.effects.consumedIds.add(existing.effect.id);
              return { refused };
            }
          } else if (
            stored?.expected === undefined &&
            request.effectRequest !== existing.effect.request &&
            (await updateIntendedEffectRequest(
              deps,
              runId,
              existing.effect.id,
              request.effectRequest,
            ))
          ) {
            effectRequest = request.effectRequest;
          }
        } else {
          const checkArgs =
            stored && argumentGiven(stored.routineId)
              ? { ...args, routineId: stored.routineId }
              : args;
          const resolved = await scheduleCancelPreview(ctx, checkArgs);
          if ("error" in resolved) {
            const refused = refusal("schedule_cancel_refused", resolved.error);
            if (await completeIntendedEffect(deps, runId, existing.effect.id, refused)) {
              nextMutatingEffectOccurrence(
                ctx,
                replayEffectToolName,
                keyArgs,
                executionId,
                pinnedEffectKey,
              );
              ctx.state.effects.consumedIds.add(existing.effect.id);
              return { refused };
            }
          }
        }
      }
    }
    return { args, effectRequest, pinnedEffectKey };
  }
  if (name === "schedule_update") {
    const refused = await prepareScheduleUpdateApproval(ctx, request);
    if (refused) return { refused };
    effectRequest = request.effectRequest;
  } else {
    const refused = await prepareScheduleCancelApproval(ctx, request);
    if (refused) return { refused };
    args = request.args;
    effectRequest = request.effectRequest;
  }
  return { args, effectRequest, pinnedEffectKey };
}
