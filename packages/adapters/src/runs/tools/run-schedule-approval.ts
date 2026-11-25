import {
  isToolEffectIdempotencyKey,
  stableJsonValue,
  toolEffectIdempotencyKey,
} from "@rakazo/core/node/approval-effect-key";
import { approvedReplayArgs } from "../../approvals/approval-effect.js";
import { argumentGiven } from "../../bots/update-bot-patch.js";
import { reachesManagedRoutines } from "../../routines/routine-target.js";
import { resolveBot } from "../../tools/fleet-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { peekMutatingEffectOccurrence, restoredPendingEffectKey } from "../assembly/run-context.js";
import {
  CATALOG_APPROVAL_TOOL,
  completeIntendedEffect,
  findRecordedEffect,
} from "../lifecycle/run-effects.js";
import { refusal } from "../turn/tool-refusal.js";
import type { ToolRequest } from "./run-tool-request.js";
import { scheduleCancelPreview } from "./run-tools-tasks.js";

function tryStableJsonValue(value: unknown): string | undefined {
  try {
    return stableJsonValue(value);
  } catch {
    return undefined;
  }
}

function modernEffectKeyParts(
  idempotencyKey: string,
  runId: string,
  kind: string,
): { fingerprint: string; occurrence: number } | undefined {
  if (!isToolEffectIdempotencyKey(idempotencyKey, runId, kind)) return undefined;
  const prefix = `${runId}:${kind}:`;
  const [digest, suffix] = idempotencyKey.slice(prefix.length).split(":");
  if (!digest) return undefined;
  const occurrence = suffix === undefined ? 0 : Number(suffix);
  return Number.isInteger(occurrence) && occurrence >= 0
    ? { fingerprint: prefix + digest, occurrence }
    : undefined;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Canonicalize the active `schedule_cancel` selector (`routineId` wins; otherwise trimmed `name`)
 * so padded names or empty `routineId` strings share one stable effect key with trimmed retries.
 */
export function canonicalScheduleCancelSelectorArgs(
  rest: Record<string, unknown>,
): Record<string, unknown> {
  const { routineId: rawRoutineId, name: rawName, ...other } = rest;
  const routineId = trimmedString(rawRoutineId);
  if (routineId) return { ...other, routineId };
  const name = trimmedString(rawName);
  if (name) return { ...other, name };
  return rest;
}

function scheduleCancelSelectorMatches(
  callerRest: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  const callerRoutineId = trimmedString(callerRest.routineId);
  const callerName = trimmedString(callerRest.name);
  if (!callerRoutineId && !callerName) return false;
  const storedRoutineId = trimmedString(stored.routineId);
  return callerRoutineId
    ? storedRoutineId === callerRoutineId
    : !storedRoutineId && trimmedString(stored.name) === callerName;
}

async function unconsumedRunEffects(ctx: RunContext, kind: string, stopBeforeId?: string) {
  const { deps, run } = ctx;
  const consumedIds = ctx.state?.effects?.consumedIds;
  const prior = await deps.prisma.externalEffect!.findMany({
    where: { runId: run.id, spaceId: run.spaceId, kind },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const matching = [];
  for (const candidate of prior) {
    if (stopBeforeId && candidate.id === stopBeforeId) break;
    if (consumedIds?.has(candidate.id)) continue;
    if (candidate.runId !== run.id || candidate.spaceId !== run.spaceId || candidate.kind !== kind)
      continue;
    matching.push(candidate);
  }
  return matching;
}

async function findDirectKeyedEffect(
  ctx: RunContext,
  kind: string,
  candidates: readonly Record<string, unknown>[],
  canonicalOcc: number,
) {
  const { deps, run } = ctx;
  const consumedIds = ctx.state?.effects?.consumedIds;
  const counts = ctx.state?.effects?.counts;
  for (const candidateArgs of candidates) {
    const fingerprint = toolEffectIdempotencyKey(ctx.runId, kind, candidateArgs);
    if ((counts?.get(fingerprint) ?? 0) > canonicalOcc) continue;
    const key = toolEffectIdempotencyKey(ctx.runId, kind, candidateArgs, canonicalOcc);
    const found = await findRecordedEffect(deps, run, kind, key);
    if (found && found.effect.kind === kind && !consumedIds?.has(found.effect.id)) {
      return found.effect;
    }
  }
  return undefined;
}

/** Match a caller's `schedule_cancel` selector against a stored receipt without colliding ID and name selectors. */
function matchesScheduleCancelReceipt(
  ctx: RunContext,
  candidateKey: string,
  parts: { fingerprint: string; occurrence: number } | undefined,
  callerRest: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  const callerRoutineId = trimmedString(callerRest.routineId);
  const callerName = trimmedString(callerRest.name);
  if (!callerRoutineId && !callerName) return false;
  const storedBotId = trimmedString(stored.bot_id);
  const storedBotName = trimmedString(stored.bot_name);
  if (parts && storedBotId) {
    const { bot_id: _sId, bot_name: _sName, ...storedRawRest } = stored;
    const restVariants: Record<string, unknown>[] = [
      canonicalScheduleCancelSelectorArgs(callerRest),
      callerRest,
      ...(scheduleCancelSelectorMatches(callerRest, stored) ? [storedRawRest] : []),
    ];
    for (const variant of restVariants) {
      const canonicalArgs =
        storedBotId === ctx.bot.id ? variant : { ...variant, bot_id: storedBotId };
      if (
        tryStableJsonValue(canonicalArgs) !== undefined &&
        toolEffectIdempotencyKey(ctx.runId, "schedule_cancel", canonicalArgs, parts.occurrence) ===
          candidateKey
      ) {
        return true;
      }
      if (storedBotId !== ctx.bot.id && storedBotName) {
        const prevArgs = { ...variant, bot_id: storedBotId, bot_name: storedBotName };
        if (
          tryStableJsonValue(prevArgs) !== undefined &&
          toolEffectIdempotencyKey(ctx.runId, "schedule_cancel", prevArgs, parts.occurrence) ===
            candidateKey
        ) {
          return true;
        }
      }
    }
    return false;
  }
  return scheduleCancelSelectorMatches(callerRest, stored);
}

function matchesHashedPrevNameScheduleCancel(
  ctx: RunContext,
  candidateKey: string,
  parts: { fingerprint: string; occurrence: number },
  callerRest: Record<string, unknown>,
  stored: Record<string, unknown>,
  storedBotId: string,
  rawName: string,
): boolean {
  if (!trimmedString(callerRest.routineId) && !trimmedString(callerRest.name)) return false;
  const { bot_id: _sId, bot_name: _sName, ...storedRawRest } = stored;
  const restVariants: Record<string, unknown>[] = [
    canonicalScheduleCancelSelectorArgs(callerRest),
    callerRest,
    ...(scheduleCancelSelectorMatches(callerRest, stored) ? [storedRawRest] : []),
  ];
  for (const variant of restVariants) {
    const prevArgs = { ...variant, bot_id: storedBotId, bot_name: rawName };
    if (
      tryStableJsonValue(prevArgs) !== undefined &&
      toolEffectIdempotencyKey(ctx.runId, "schedule_cancel", prevArgs, parts.occurrence) ===
        candidateKey
    ) {
      return true;
    }
  }
  return false;
}

/** Reconcile an unconsumed name-only managed-routine effect before live name resolution. */
async function findPriorNamedManagedRoutineEffect(
  ctx: RunContext,
  kind: string,
  args: Record<string, unknown>,
) {
  if (!ctx.deps.prisma.externalEffect?.findMany) return undefined;
  if (argumentGiven(args.bot_id) || typeof args.bot_name !== "string") return undefined;
  const rawName = args.bot_name.trim();
  if (!rawName) return undefined;
  const { bot_id: _id, bot_name: _name, ...rest } = args;
  const expectedRest = kind === "schedule_cancel" ? undefined : tryStableJsonValue(rest);
  if (kind !== "schedule_cancel" && expectedRest === undefined) return undefined;

  const counts = ctx.state?.effects?.counts;
  for (const candidate of await unconsumedRunEffects(ctx, kind)) {
    const parts = modernEffectKeyParts(candidate.idempotencyKey, ctx.runId, kind);
    if (parts) {
      if ((counts?.get(parts.fingerprint) ?? 0) > parts.occurrence) continue;
    } else if ((counts?.get(candidate.idempotencyKey) ?? 0) > 0) {
      continue;
    }
    const stored = storedRequestObject(candidate.request);
    if (!stored) continue;
    const hasMatchingBotName =
      typeof stored.bot_name === "string" && stored.bot_name.trim() === rawName;
    if (!hasMatchingBotName) {
      const storedBotId = trimmedString(stored.bot_id);
      if (!parts || !storedBotId || storedBotId === ctx.bot.id || argumentGiven(stored.bot_name))
        continue;
      if (kind === "schedule_cancel") {
        if (
          matchesHashedPrevNameScheduleCancel(
            ctx,
            candidate.idempotencyKey,
            parts,
            rest,
            stored,
            storedBotId,
            rawName,
          )
        ) {
          return candidate;
        }
        continue;
      }
      const { bot_id: _sId, bot_name: _sName, ...storedRest } = stored;
      const comparable =
        kind === "schedule_update"
          ? (({ expected: _expected, ...withoutExpected }) => withoutExpected)(storedRest)
          : storedRest;
      if (tryStableJsonValue(comparable) !== expectedRest) continue;
      const prevArgs = { ...comparable, bot_id: storedBotId, bot_name: rawName };
      if (
        tryStableJsonValue(prevArgs) !== undefined &&
        candidate.idempotencyKey ===
          toolEffectIdempotencyKey(ctx.runId, kind, prevArgs, parts.occurrence)
      ) {
        return candidate;
      }
      continue;
    }
    if (kind === "schedule_cancel") {
      if (matchesScheduleCancelReceipt(ctx, candidate.idempotencyKey, parts, rest, stored)) {
        return candidate;
      }
      continue;
    }
    const { bot_id: _storedId, bot_name: _storedName, ...storedRest } = stored;
    const comparable =
      kind === "schedule_update"
        ? (({ expected: _expected, ...withoutExpected }) => withoutExpected)(storedRest)
        : storedRest;
    if (tryStableJsonValue(comparable) === expectedRest) return candidate;
  }
  return undefined;
}

/** Find an unconsumed previous-release or legacy managed-routine effect in creation order. */
async function findPreviousReleaseManagedRoutineEffect(
  ctx: RunContext,
  kind: string,
  targetId: string,
  rawCallerArgs: Record<string, unknown>,
  resolvedArgs: Record<string, unknown>,
  canonicalKeyArgs: Record<string, unknown>,
  canonicalOcc: number,
  stopBeforeId?: string,
) {
  if (!ctx.deps.prisma.externalEffect?.findMany) {
    return stopBeforeId
      ? undefined
      : findDirectKeyedEffect(ctx, kind, [resolvedArgs], canonicalOcc);
  }
  const counts = ctx.state?.effects?.counts;
  const prevFingerprint = toolEffectIdempotencyKey(ctx.runId, kind, resolvedArgs);
  const canonicalFingerprint = toolEffectIdempotencyKey(ctx.runId, kind, canonicalKeyArgs);
  const expectedCanonicalRequest = tryStableJsonValue(canonicalKeyArgs);
  const expectedRawRequest = tryStableJsonValue(rawCallerArgs);
  const { bot_id: _rId, bot_name: _rName, ...resolvedRest } = resolvedArgs;
  for (const candidate of await unconsumedRunEffects(ctx, kind, stopBeforeId)) {
    const parts = modernEffectKeyParts(candidate.idempotencyKey, ctx.runId, kind);
    if (!parts) {
      if ((counts?.get(candidate.idempotencyKey) ?? 0) > 0) continue;
      if (
        expectedRawRequest !== undefined &&
        tryStableJsonValue(candidate.request) === expectedRawRequest
      ) {
        return candidate;
      }
      const stored = storedRequestObject(candidate.request);
      if (!stored || trimmedString(stored.bot_id) !== targetId) continue;
      const { bot_id: _sId, bot_name: _sName, ...storedRest } = stored;
      if (kind === "schedule_cancel") {
        if (scheduleCancelSelectorMatches(resolvedRest, storedRest)) return candidate;
        continue;
      }
      const comparable =
        kind === "schedule_update"
          ? (({ expected: _expected, ...rest }) => rest)(storedRest)
          : storedRest;
      if (
        expectedCanonicalRequest !== undefined &&
        tryStableJsonValue({ ...comparable, bot_id: targetId }) === expectedCanonicalRequest
      ) {
        return candidate;
      }
      continue;
    }
    if (parts.fingerprint === canonicalFingerprint) continue;
    if ((counts?.get(parts.fingerprint) ?? 0) > parts.occurrence) continue;
    if (parts.fingerprint === prevFingerprint) return candidate;
    const stored = storedRequestObject(candidate.request);
    if (!stored) continue;
    if (typeof stored.bot_name === "string" && stored.bot_name.trim()) {
      const trimmedName = stored.bot_name.trim();
      const candidateNames =
        trimmedName === stored.bot_name ? [trimmedName] : [trimmedName, stored.bot_name];
      const keyBases: Record<string, unknown>[] = [
        canonicalKeyArgs,
        { ...resolvedRest, bot_id: targetId },
      ];
      if (kind === "schedule_cancel" && scheduleCancelSelectorMatches(resolvedRest, stored)) {
        const { bot_id: _sId, bot_name: _sName, ...storedRawRest } = stored;
        keyBases.push({ ...storedRawRest, bot_id: targetId });
      }
      for (const candidateName of candidateNames) {
        for (const base of keyBases) {
          if (tryStableJsonValue(base) === undefined) continue;
          const oldNameKey = toolEffectIdempotencyKey(
            ctx.runId,
            kind,
            { ...base, bot_name: candidateName },
            parts.occurrence,
          );
          if (candidate.idempotencyKey === oldNameKey) return candidate;
        }
      }
    }
    if (
      !argumentGiven(stored.bot_name) &&
      typeof stored.bot_id === "string" &&
      stored.bot_id.trim() === targetId &&
      expectedCanonicalRequest !== undefined
    ) {
      const { bot_id: _storedBotId, bot_name: _storedBotName, ...storedRest } = stored;
      if (kind === "schedule_cancel") {
        const storedName = trimmedString(storedRest.name);
        if (
          storedName &&
          candidate.idempotencyKey ===
            toolEffectIdempotencyKey(
              ctx.runId,
              kind,
              { bot_id: targetId, name: storedName },
              parts.occurrence,
            )
        ) {
          continue;
        }
      }
      const normalizedRest =
        kind === "schedule_cancel"
          ? canonicalScheduleCancelSelectorArgs(storedRest)
          : kind === "schedule_update"
            ? (({ expected: _expected, ...rest }) => rest)(storedRest)
            : storedRest;
      if (tryStableJsonValue({ ...normalizedRest, bot_id: targetId }) === expectedCanonicalRequest)
        return candidate;
    }
  }
  return undefined;
}

/** Find an unconsumed previous-release, legacy, or earlier canonical own-bot `schedule_cancel` receipt. */
async function findPreviousReleaseOwnScheduleCancelEffect(
  ctx: RunContext,
  rawCallerArgs: Record<string, unknown>,
  rawRest: Record<string, unknown>,
  canonicalRest: Record<string, unknown>,
  canonicalOcc: number,
  stopBeforeId?: string,
  includeCanonical = false,
) {
  if (!ctx.deps.prisma.externalEffect?.findMany) {
    if (stopBeforeId) return undefined;
    const canonicalJson = tryStableJsonValue(canonicalRest);
    const directCandidates: Record<string, unknown>[] = [];
    if (tryStableJsonValue(rawRest) !== undefined && tryStableJsonValue(rawRest) !== canonicalJson)
      directCandidates.push(rawRest);
    if (
      !argumentGiven(rawCallerArgs.bot_id) &&
      !argumentGiven(rawCallerArgs.bot_name) &&
      tryStableJsonValue(rawCallerArgs) !== undefined &&
      tryStableJsonValue(rawCallerArgs) !== canonicalJson &&
      tryStableJsonValue(rawCallerArgs) !== tryStableJsonValue(rawRest)
    ) {
      directCandidates.push(rawCallerArgs);
    }
    return findDirectKeyedEffect(ctx, "schedule_cancel", directCandidates, canonicalOcc);
  }
  if (!trimmedString(rawRest.routineId) && !trimmedString(rawRest.name)) return undefined;
  const counts = ctx.state?.effects?.counts;
  const canonicalFingerprint = toolEffectIdempotencyKey(
    ctx.runId,
    "schedule_cancel",
    canonicalRest,
  );
  const expectedRawRequest = tryStableJsonValue(rawCallerArgs);
  for (const candidate of await unconsumedRunEffects(ctx, "schedule_cancel", stopBeforeId)) {
    const parts = modernEffectKeyParts(candidate.idempotencyKey, ctx.runId, "schedule_cancel");
    if (!parts) {
      if ((counts?.get(candidate.idempotencyKey) ?? 0) > 0) continue;
      if (
        expectedRawRequest !== undefined &&
        tryStableJsonValue(candidate.request) === expectedRawRequest
      ) {
        return candidate;
      }
      const stored = storedRequestObject(candidate.request);
      if (!stored) continue;
      const storedBotId = trimmedString(stored.bot_id);
      if (storedBotId && storedBotId !== ctx.bot.id) continue;
      if (!storedBotId && argumentGiven(stored.bot_name)) continue;
      if (scheduleCancelSelectorMatches(rawRest, stored)) return candidate;
      continue;
    }
    if ((counts?.get(parts.fingerprint) ?? 0) > parts.occurrence) continue;
    if (parts.fingerprint === canonicalFingerprint) {
      if (includeCanonical) return candidate;
      continue;
    }
    const stored = storedRequestObject(candidate.request);
    if (!stored) continue;
    const storedBotId = trimmedString(stored.bot_id);
    if (storedBotId && storedBotId !== ctx.bot.id) continue;
    if (!scheduleCancelSelectorMatches(rawRest, stored)) continue;
    const { bot_id: _sId, bot_name: _sName, ...storedRawRest } = stored;
    const keyCandidates: Record<string, unknown>[] = [storedRawRest];
    if (!argumentGiven(stored.bot_id) && !argumentGiven(stored.bot_name)) {
      keyCandidates.push(stored);
    }
    for (const keyCandidate of keyCandidates) {
      if (
        tryStableJsonValue(keyCandidate) !== undefined &&
        candidate.idempotencyKey ===
          toolEffectIdempotencyKey(ctx.runId, "schedule_cancel", keyCandidate, parts.occurrence)
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Find an unconsumed previous-release, legacy, or earlier canonical own-bot `schedule_list` receipt. */
async function findPreviousReleaseOwnScheduleListEffect(
  ctx: RunContext,
  rawCallerArgs: Record<string, unknown>,
  canonicalRest: Record<string, unknown>,
  canonicalOcc: number,
  stopBeforeId?: string,
  includeCanonical = false,
) {
  const canonicalJson = tryStableJsonValue(canonicalRest);
  if (canonicalJson === undefined) return undefined;
  if (!ctx.deps.prisma.externalEffect?.findMany) {
    if (
      stopBeforeId ||
      argumentGiven(rawCallerArgs.bot_id) ||
      argumentGiven(rawCallerArgs.bot_name) ||
      tryStableJsonValue(rawCallerArgs) === undefined ||
      tryStableJsonValue(rawCallerArgs) === canonicalJson
    ) {
      return undefined;
    }
    return findDirectKeyedEffect(ctx, "schedule_list", [rawCallerArgs], canonicalOcc);
  }
  const counts = ctx.state?.effects?.counts;
  const canonicalFingerprint = toolEffectIdempotencyKey(ctx.runId, "schedule_list", canonicalRest);
  const expectedRawRequest = tryStableJsonValue(rawCallerArgs);
  for (const candidate of await unconsumedRunEffects(ctx, "schedule_list", stopBeforeId)) {
    const parts = modernEffectKeyParts(candidate.idempotencyKey, ctx.runId, "schedule_list");
    if (!parts) {
      if ((counts?.get(candidate.idempotencyKey) ?? 0) > 0) continue;
      if (
        expectedRawRequest !== undefined &&
        tryStableJsonValue(candidate.request) === expectedRawRequest
      ) {
        return candidate;
      }
      const stored = storedRequestObject(candidate.request);
      if (!stored || argumentGiven(stored.bot_id) || argumentGiven(stored.bot_name)) continue;
      const { bot_id: _sId, bot_name: _sName, ...storedRest } = stored;
      if (tryStableJsonValue(storedRest) === canonicalJson) return candidate;
      continue;
    }
    if ((counts?.get(parts.fingerprint) ?? 0) > parts.occurrence) continue;
    if (parts.fingerprint === canonicalFingerprint) {
      if (includeCanonical) return candidate;
      continue;
    }
    const stored = storedRequestObject(candidate.request);
    if (!stored || argumentGiven(stored.bot_id) || argumentGiven(stored.bot_name)) continue;
    const { bot_id: _sId, bot_name: _sName, ...storedRest } = stored;
    if (tryStableJsonValue(storedRest) !== canonicalJson) continue;
    if (
      tryStableJsonValue(stored) !== undefined &&
      candidate.idempotencyKey ===
        toolEffectIdempotencyKey(ctx.runId, "schedule_list", stored, parts.occurrence)
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Reconcile a saved checkpoint, legacy scoped, canonical, or raw-selector previous-release effect
 * on an own-bot routine call (with or without explicit self `bot_id`) before live canonical keying.
 */
export async function reconcileSelfBotRoutineEffect(
  ctx: RunContext,
  request: ToolRequest,
  rawCallerArgs: Record<string, unknown>,
  rawRest: Record<string, unknown>,
  canonicalRest: Record<string, unknown>,
): Promise<void> {
  const { deps, run } = ctx;
  const { executionId, replayEffectToolName } = request;
  const pendingKey = restoredPendingEffectKey(ctx, executionId);
  if (pendingKey) {
    const foundPending = await findRecordedEffect(deps, run, replayEffectToolName, pendingKey);
    if (foundPending && foundPending.effect.kind === replayEffectToolName) {
      ctx.state.effects.restoredPending = undefined;
      request.reconciledEffectKey = foundPending.matchedKey;
      request.effectRequest = foundPending.effect.request;
      return;
    }
  }

  const consumedIds = ctx.state?.effects?.consumedIds;
  const counts = ctx.state?.effects?.counts;
  const canonicalOcc = peekMutatingEffectOccurrence(
    ctx,
    replayEffectToolName,
    canonicalRest,
    executionId,
  );
  const canonicalKey = toolEffectIdempotencyKey(
    ctx.runId,
    replayEffectToolName,
    canonicalRest,
    canonicalOcc,
  );
  const found = await findRecordedEffect(
    deps,
    run,
    replayEffectToolName,
    canonicalKey,
    rawCallerArgs,
    executionId,
    consumedIds,
    counts,
  );
  const activeFound =
    found &&
    !consumedIds?.has(found.effect.id) &&
    (!found.legacy || (counts?.get(found.matchedKey) ?? 0) === 0)
      ? found
      : undefined;
  if (replayEffectToolName === "schedule_cancel" || replayEffectToolName === "schedule_list") {
    const previous =
      replayEffectToolName === "schedule_cancel"
        ? await findPreviousReleaseOwnScheduleCancelEffect(
            ctx,
            rawCallerArgs,
            rawRest,
            canonicalRest,
            canonicalOcc,
            activeFound?.effect.id,
          )
        : await findPreviousReleaseOwnScheduleListEffect(
            ctx,
            rawCallerArgs,
            canonicalRest,
            canonicalOcc,
            activeFound?.effect.id,
          );
    if (previous) {
      request.reconciledEffectKey = previous.idempotencyKey;
      request.effectRequest = previous.request;
      return;
    }
  }
  if (activeFound) {
    request.reconciledEffectKey = activeFound.matchedKey;
    request.effectRequest = activeFound.effect.request;
  }
}

/** Plain request object extracted from a stored ExternalEffect.request JSON column. */
export function storedRequestObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return approvedReplayArgs(value, {}, CATALOG_APPROVAL_TOOL);
}

/**
 * Guard duplicate `intended` effects that lack a pinned target id:
 * - an unpinned `schedule_cancel` settles as uncertain because an earlier attempt may already
 *   have deleted the routine before crashing,
 * - an unpinned managed-routine request (`bot_name` without `bot_id`) is refused so the model
 *   retries with the resolved bot id.
 */
export function intendedScheduleGateAction(
  name: string,
  effect: { status: string; request: unknown },
): "uncertain" | { error: string } | undefined {
  if (effect.status !== "intended") return undefined;
  const stored = storedRequestObject(effect.request);
  if (name === "schedule_cancel" && !(stored && argumentGiven(stored.routineId))) {
    return "uncertain";
  }
  if (stored && reachesManagedRoutines(name, stored) && !argumentGiven(stored.bot_id)) {
    return refusal(
      "unpinned_managed_routine_effect",
      "This pending request named the bot without its id; call the tool again with bot_id so it targets the exact bot.",
    );
  }
  return undefined;
}

/** Resolve a schedule_cancel target before approval so the card and replay pin its routineId. */
export async function prepareScheduleCancelApproval(ctx: RunContext, request: ToolRequest) {
  const resolved = await scheduleCancelPreview(ctx, request.args);
  if ("error" in resolved) return refusal("schedule_cancel_refused", resolved.error);
  const pinned = { ...request.args, routineId: resolved.routineId, name: resolved.name };
  request.args = pinned;
  const preserved = request.preserveEffectRequest
    ? storedRequestObject(request.effectRequest)
    : undefined;
  request.effectRequest = preserved ? { ...preserved, ...pinned } : pinned;
  return undefined;
}

async function reconcileManagedTargetEffect(
  ctx: RunContext,
  kind: string,
  targetId: string,
  rawCallerArgs: Record<string, unknown>,
  resolvedArgs: Record<string, unknown>,
  canonicalKeyArgs: Record<string, unknown>,
  executionId: string,
): Promise<{ id: string; matchedKey: string; request: unknown; status: string } | undefined> {
  const { deps, run, bot } = ctx;
  const consumedIds = ctx.state?.effects?.consumedIds;
  const counts = ctx.state?.effects?.counts;
  const canonicalOcc = peekMutatingEffectOccurrence(ctx, kind, canonicalKeyArgs, executionId);
  const canonicalKey = toolEffectIdempotencyKey(ctx.runId, kind, canonicalKeyArgs, canonicalOcc);
  const canonicalFound = await findRecordedEffect(
    deps,
    run,
    kind,
    canonicalKey,
    rawCallerArgs,
    executionId,
    consumedIds,
    counts,
  );
  const activeCanonical =
    canonicalFound &&
    !consumedIds?.has(canonicalFound.effect.id) &&
    (!canonicalFound.legacy || (counts?.get(canonicalFound.matchedKey) ?? 0) === 0)
      ? canonicalFound
      : undefined;
  const { bot_id: _rId, bot_name: _rName, ...rest } = rawCallerArgs;
  const previous =
    targetId !== bot.id
      ? await findPreviousReleaseManagedRoutineEffect(
          ctx,
          kind,
          targetId,
          rawCallerArgs,
          resolvedArgs,
          canonicalKeyArgs,
          canonicalOcc,
          activeCanonical?.effect.id,
        )
      : kind === "schedule_cancel"
        ? await findPreviousReleaseOwnScheduleCancelEffect(
            ctx,
            rawCallerArgs,
            rest,
            canonicalKeyArgs,
            canonicalOcc,
            activeCanonical?.effect.id,
          )
        : kind === "schedule_list"
          ? await findPreviousReleaseOwnScheduleListEffect(
              ctx,
              rawCallerArgs,
              canonicalKeyArgs,
              canonicalOcc,
              activeCanonical?.effect.id,
            )
          : undefined;
  if (previous) {
    return {
      id: previous.id,
      matchedKey: previous.idempotencyKey,
      request: previous.request,
      status: previous.status,
    };
  }
  if (activeCanonical) {
    return {
      id: activeCanonical.effect.id,
      matchedKey: activeCanonical.matchedKey,
      request: activeCanonical.effect.request,
      status: activeCanonical.effect.status,
    };
  }
  return undefined;
}

/** True when a reconciled receipt can settle without executing against or approving a dead bot. */
function canSettleWithoutTarget(
  name: string,
  effect: { status: string; request: unknown },
): boolean {
  if (
    effect.status === "completed" ||
    effect.status === "denied" ||
    effect.status === "approved" ||
    effect.status === "executing" ||
    effect.status === "uncertain"
  ) {
    return true;
  }
  return effect.status === "intended" && intendedScheduleGateAction(name, effect) !== undefined;
}

function consumeEffectReceipt(
  ctx: RunContext,
  kind: string,
  effect: { id: string; idempotencyKey: string },
  executionId: string,
) {
  const effects = ctx.state?.effects;
  if (!effects) return;
  effects.consumedIds.add(effect.id);
  if (effects.restoredPending?.executionId === executionId) {
    effects.restoredPending = undefined;
  }
  const parts = modernEffectKeyParts(effect.idempotencyKey, ctx.runId, kind);
  const fingerprint = parts ? parts.fingerprint : effect.idempotencyKey;
  const occurrence = parts ? parts.occurrence : 0;
  effects.occurrences.push({ executionId, fingerprint, occurrence });
  effects.counts.set(fingerprint, Math.max(effects.counts.get(fingerprint) ?? 0, occurrence + 1));
}

/** Refuse a reconciled non-terminal managed-bot receipt whose target bot is no longer active. */
async function ensureActiveManagedTarget(
  ctx: RunContext,
  kind: string,
  effect: { id: string; idempotencyKey: string; status: string; request: unknown },
  executionId: string,
): Promise<{ error: string } | undefined> {
  if (canSettleWithoutTarget(kind, effect)) return undefined;
  const stored = storedRequestObject(effect.request);
  const targetBotId = stored ? trimmedString(stored.bot_id) : "";
  if (!targetBotId || targetBotId === ctx.bot.id) return undefined;
  const active = await resolveBot(ctx.deps.prisma, ctx.fleetRun, { bot_id: targetBotId });
  if (!("error" in active)) return undefined;
  const refused = refusal("bot_management_request_invalid", active.error);
  if (effect.status === "intended") {
    if (!(await completeIntendedEffect(ctx.deps, ctx.runId, effect.id, refused))) {
      return undefined;
    }
  }
  consumeEffectReceipt(ctx, kind, effect, executionId);
  return refused;
}

/** Resolve a managed-routine call while preserving reconciliation across renames, archival, and upgrades. */
export async function prepareManagedRoutineTarget(
  ctx: RunContext,
  request: ToolRequest,
  args: Record<string, unknown>,
): Promise<{ args: Record<string, unknown> } | { error: string }> {
  const { deps, run, bot } = ctx;
  const { executionId, replayEffectToolName } = request;
  const bindReconciled = (
    matchedKey: string,
    storedRequest: unknown,
    target?: { id: string; name: string },
  ) => {
    request.reconciledEffectKey = matchedKey;
    const stored = storedRequestObject(storedRequest);
    if (!stored) return args;
    const { expected: _expected, ...withoutExpected } = stored;
    request.effectRequest = storedRequest;
    if (trimmedString(withoutExpected.bot_id) === bot.id) {
      const { bot_id: _selfId, bot_name: _selfName, ...selfRest } = withoutExpected;
      return selfRest;
    }
    if (
      target &&
      target.id !== bot.id &&
      trimmedString(withoutExpected.bot_id) === target.id &&
      !argumentGiven(withoutExpected.bot_name)
    ) {
      return { ...withoutExpected, bot_name: target.name };
    }
    return withoutExpected;
  };

  const pendingKey = restoredPendingEffectKey(ctx, executionId);
  if (pendingKey) {
    const found = await findRecordedEffect(deps, run, replayEffectToolName, pendingKey);
    if (found && found.effect.kind === replayEffectToolName) {
      ctx.state.effects.restoredPending = undefined;
      const inactive = await ensureActiveManagedTarget(
        ctx,
        replayEffectToolName,
        found.effect,
        executionId,
      );
      if (inactive) return inactive;
      return { args: bindReconciled(found.matchedKey, found.effect.request) };
    }
  }

  const priorNamed = await findPriorNamedManagedRoutineEffect(ctx, replayEffectToolName, args);
  if (priorNamed) {
    if (replayEffectToolName === "schedule_cancel" || replayEffectToolName === "schedule_list") {
      const priorStored = storedRequestObject(priorNamed.request);
      const priorBotId = priorStored ? trimmedString(priorStored.bot_id) : "";
      let priorIsOwnBot = priorBotId === bot.id;
      if (!priorIsOwnBot && priorStored && !priorBotId) {
        const priorParts = modernEffectKeyParts(
          priorNamed.idempotencyKey,
          ctx.runId,
          replayEffectToolName,
        );
        if (priorParts) {
          const { bot_id: _pId, bot_name: _pName, ...priorRawRest } = priorStored;
          priorIsOwnBot =
            tryStableJsonValue(priorRawRest) !== undefined &&
            priorNamed.idempotencyKey ===
              toolEffectIdempotencyKey(
                ctx.runId,
                replayEffectToolName,
                priorRawRest,
                priorParts.occurrence,
              );
        }
      }
      if (priorIsOwnBot) {
        const { bot_id: _id, bot_name: _name, ...rest } = args;
        const canonicalRest =
          replayEffectToolName === "schedule_cancel"
            ? canonicalScheduleCancelSelectorArgs(rest)
            : rest;
        const canonicalOcc = peekMutatingEffectOccurrence(
          ctx,
          replayEffectToolName,
          canonicalRest,
          executionId,
        );
        const earlierOwn =
          replayEffectToolName === "schedule_cancel"
            ? await findPreviousReleaseOwnScheduleCancelEffect(
                ctx,
                args,
                rest,
                canonicalRest,
                canonicalOcc,
                priorNamed.id,
                true,
              )
            : await findPreviousReleaseOwnScheduleListEffect(
                ctx,
                args,
                canonicalRest,
                canonicalOcc,
                priorNamed.id,
                true,
              );
        if (earlierOwn) {
          request.effectKeyArgs = canonicalRest;
          return { args: bindReconciled(earlierOwn.idempotencyKey, earlierOwn.request) };
        }
      }
    }
    const inactive = await ensureActiveManagedTarget(
      ctx,
      replayEffectToolName,
      priorNamed,
      executionId,
    );
    if (inactive) return inactive;
    return { args: bindReconciled(priorNamed.idempotencyKey, priorNamed.request) };
  }

  const rawCallerArgs = args;
  const target = await resolveBot(deps.prisma, ctx.fleetRun, args);
  if ("error" in target) {
    const explicitBotId = trimmedString(args.bot_id);
    if (explicitBotId && explicitBotId !== bot.id && !argumentGiven(args.bot_name)) {
      const { bot_id: _id, bot_name: _name, ...rest } = args;
      const keyRest =
        replayEffectToolName === "schedule_cancel"
          ? canonicalScheduleCancelSelectorArgs(rest)
          : rest;
      const canonicalKeyArgs = { ...keyRest, bot_id: explicitBotId };
      const reconciled = await reconcileManagedTargetEffect(
        ctx,
        replayEffectToolName,
        explicitBotId,
        rawCallerArgs,
        { ...rest, bot_id: explicitBotId },
        canonicalKeyArgs,
        executionId,
      );
      if (reconciled) {
        if (canSettleWithoutTarget(replayEffectToolName, reconciled)) {
          request.effectKeyArgs = canonicalKeyArgs;
          return { args: bindReconciled(reconciled.matchedKey, reconciled.request) };
        }
        if (reconciled.status === "intended") {
          const refused = refusal("bot_management_request_invalid", target.error);
          if (await completeIntendedEffect(deps, ctx.runId, reconciled.id, refused)) {
            consumeEffectReceipt(
              ctx,
              replayEffectToolName,
              { id: reconciled.id, idempotencyKey: reconciled.matchedKey },
              executionId,
            );
            return refused;
          }
          request.effectKeyArgs = canonicalKeyArgs;
          return { args: bindReconciled(reconciled.matchedKey, reconciled.request) };
        }
      }
    }
    return refusal("bot_management_request_invalid", target.error);
  }
  const { bot_id: _id, bot_name: _name, ...rest } = args;
  const resolvedArgs =
    target.id === bot.id ? rest : { ...rest, bot_id: target.id, bot_name: target.name };
  const keyRest =
    replayEffectToolName === "schedule_cancel" ? canonicalScheduleCancelSelectorArgs(rest) : rest;
  const canonicalKeyArgs = target.id === bot.id ? keyRest : { ...keyRest, bot_id: target.id };
  request.effectKeyArgs = canonicalKeyArgs;
  if (target.id === bot.id && argumentGiven(rawCallerArgs.bot_name)) {
    // Preserve the named self-bot selector in the persisted receipt so a retry after renaming this
    // bot and another bot taking the old name still reconciles this receipt.
    request.effectRequest = { ...rest, bot_id: bot.id, bot_name: target.name };
    request.preserveEffectRequest = true;
  }

  const reconciled = await reconcileManagedTargetEffect(
    ctx,
    replayEffectToolName,
    target.id,
    rawCallerArgs,
    resolvedArgs,
    canonicalKeyArgs,
    executionId,
  );
  if (reconciled) {
    return { args: bindReconciled(reconciled.matchedKey, reconciled.request, target) };
  }
  return { args: resolvedArgs };
}
