import { CATALOG_APPROVAL_TOOL } from "@rakazo/contracts";
import {
  isToolEffectIdempotencyKey,
  legacyScopedToolEffectIdempotencyKey,
  stableJsonValue,
} from "@rakazo/core/node/approval-effect-key";
import type { Prisma } from "@rakazo/db";
import {
  assertRunCanWriteHistory,
  RUN_TURN_CHECKPOINT_KIND,
  runCodeKind,
  runLoginKind,
  runSecretKind,
} from "@rakazo/db";
import {
  boundDirectApprovalDetails,
  catalogApprovalConnectorId,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  catalogExecuteToolName,
  catalogIdForRoute,
  claimApprovedEffect,
  claimIntendedEffect,
  completeExternalEffect,
  parseCatalogApprovalTarget,
} from "../../approvals/approval-effect.js";
import { resolveRequestSecretDestination } from "../../secrets/bot-secrets.js";
import { USE_TOOL } from "../../tools/builtin.tool-definition.js";
import { uniquifyInstalledToolName } from "../../tools/lazy-tool-catalog.js";
import { APPROVAL_CONTINUATION_LEAD } from "../assembly/approval-continuation.prompt.js";
import { runLeaseFor } from "../assembly/run-messages.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";

/** Effects that got past the approval gate: approved, allowed by a rule or review, or run. */
export const PASSED_EFFECT_STATUSES = ["approved", "executing", "uncertain", "completed"];

export const APPROVED_EFFECT_REPLAY_ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];

export { CATALOG_APPROVAL_TOOL } from "@rakazo/contracts";

export function approvalReplayEffectToolName(
  liveName: string,
  approvedName: string | undefined,
  sameBoundResource: boolean,
): string {
  return sameBoundResource && approvedName ? approvedName : liveName;
}

export function buildApprovalContinuation(
  approvedEffects: readonly { kind: string; request: unknown }[],
  formatRequest: (request: unknown) => string,
  options?: { exposedToolNames?: ReadonlySet<string> },
): string | undefined {
  if (approvedEffects.length === 0) return undefined;
  return [
    ...APPROVAL_CONTINUATION_LEAD,
    ...approvedEffects.map((effect) => {
      const catalog = catalogApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL);
      if (catalog) {
        const exposed = options?.exposedToolNames;
        const renamedMcpWrapper = catalogExecuteToolName("mcp");
        const wrapper =
          exposed &&
          catalog.toolName === "mcp_execute_tool" &&
          !exposed.has(catalog.toolName) &&
          exposed.has(renamedMcpWrapper)
            ? renamedMcpWrapper
            : catalog.toolName;
        if (!exposed || exposed.has(wrapper)) {
          return `${wrapper}: ${formatRequest(catalog.args)}`;
        }
        // Catalog shrank: wrapper is gone — resume as the matching direct tool.
        const innerArgs = catalogApprovalInnerArgs(catalog) ?? {};
        if (exposed.has(effect.kind)) {
          return `${effect.kind}: ${formatRequest(innerArgs)}`;
        }
        const target = parseCatalogApprovalTarget(catalog.args);
        const connectorId = catalogApprovalConnectorId(catalog.toolName);
        const uniquified =
          target && connectorId === "installed"
            ? uniquifyInstalledToolName(target.resourceId, target.toolName)
            : undefined;
        if (uniquified && exposed.has(uniquified)) {
          return `${uniquified}: ${formatRequest(innerArgs)}`;
        }
        return `${effect.kind}: ${formatRequest(innerArgs)}`;
      }
      const bound = boundDirectApprovalDetails(effect.request, CATALOG_APPROVAL_TOOL);
      if (bound) {
        const exposed = options?.exposedToolNames;
        if (!exposed || exposed.has(effect.kind)) {
          return `${effect.kind}: ${formatRequest(bound.args)}`;
        }
        // Name collision uniquify can rename the direct tool while the catalog is still
        // small — prefer that exposed name over a catalog wrapper that does not exist yet.
        const uniquified =
          bound.route.connectorId === "installed"
            ? uniquifyInstalledToolName(bound.route.resourceId, bound.route.toolName)
            : undefined;
        if (uniquified && exposed.has(uniquified)) {
          return `${uniquified}: ${formatRequest(bound.args)}`;
        }
        const wrapper = catalogExecuteToolName(bound.route.connectorId);
        if (exposed.has(wrapper)) {
          return `${wrapper}: ${formatRequest({
            id: catalogIdForRoute(bound.route),
            arguments: bound.args,
          })}`;
        }
        return `${uniquified ?? effect.kind}: ${formatRequest(bound.args)}`;
      }
      const exposed = options?.exposedToolNames;
      return exposed && !exposed.has(effect.kind) && exposed.has(USE_TOOL)
        ? `${USE_TOOL}: ${formatRequest({ name: effect.kind, arguments: effect.request })}`
        : `${effect.kind}: ${formatRequest(effect.request)}`;
    }),
  ].join("\n");
}

/** Provider tool IDs are unique only within a run, never across users or workflows. */
export function runScopedToolExecutionId(runId: string, executionId: string): string {
  return `tool:${JSON.stringify([runId, executionId])}`;
}

/** Decode only the exact backend Pi namespace shape, never an arbitrary provider ID. */
function piToolExecution(executionId: string): { agent: string; callId: string } | undefined {
  try {
    const value: unknown = JSON.parse(executionId);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === "pi-tool" &&
      typeof value[1] === "string" &&
      value[1].length > 0 &&
      typeof value[2] === "string" &&
      value[2].length > 0
    )
      return { agent: value[1], callId: value[2] };
  } catch {
    // Other runtimes keep their existing opaque execution IDs.
  }
  return undefined;
}

export function legacyPiToolCallId(executionId: string): string | undefined {
  return piToolExecution(executionId)?.callId;
}

/** A call a helper made: Pi namespaces helper calls by the run_subagent call that started them. */
export function isSubagentToolExecution(executionId: string): boolean {
  const agent = piToolExecution(executionId)?.agent;
  return agent !== undefined && agent !== "main";
}

export async function recordEffect(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  kind: string,
  idempotencyKey: string,
  request: unknown,
  legacyIdempotencyKey?: string,
  consumedIds?: Set<string>,
  batchActions?: string[],
) {
  if (kind === RUN_TURN_CHECKPOINT_KIND) throw new Error("Unsupported tool effect kind");
  const existing = await deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey },
  });
  if (existing?.kind === RUN_TURN_CHECKPOINT_KIND || existing?.status === RUN_TURN_CHECKPOINT_KIND)
    throw new Error("Unsupported tool effect kind");
  if (existing && (existing.runId !== run.id || existing.spaceId !== run.spaceId)) {
    throw new Error("Stored tool execution does not belong to this run.");
  }
  if (existing) {
    consumedIds?.add(existing.id);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId: idempotencyKey, kind },
    });
    return { duplicate: true, effect: existing };
  }

  // Pre-fix rows used bare provider ids or scoped keys that included the
  // ephemeral model tool-call id. Same-id unique lookup still works; a restart
  // with a new id finds the row by run, tool, and request instead.
  let expectedRequest: string | undefined;
  try {
    expectedRequest = stableJsonValue(request);
  } catch {
    expectedRequest = undefined;
  }
  const rawPiId = legacyIdempotencyKey && legacyPiToolCallId(legacyIdempotencyKey);
  if (rawPiId) {
    const oldPi = await deps.prisma.externalEffect.findUnique({
      where: { idempotencyKey: rawPiId },
    });
    if (oldPi?.runId === run.id && oldPi.spaceId === run.spaceId) {
      // A bare Pi call id does not say which agent owned it. Its outcome is uncertain.
      throw uncertainEffectError(kind);
    }
  }
  if (legacyIdempotencyKey && legacyIdempotencyKey !== idempotencyKey && expectedRequest) {
    const scopedLegacy =
      request && typeof request === "object" && !Array.isArray(request)
        ? legacyScopedToolEffectIdempotencyKey(
            run.id,
            kind,
            legacyIdempotencyKey,
            request as Record<string, unknown>,
          )
        : undefined;
    for (const candidate of [scopedLegacy, legacyIdempotencyKey]) {
      if (!candidate || candidate === idempotencyKey) continue;
      const sameIdLegacy = await deps.prisma.externalEffect.findUnique({
        where: { idempotencyKey: candidate },
      });
      if (
        sameIdLegacy &&
        !consumedIds?.has(sameIdLegacy.id) &&
        sameIdLegacy.runId === run.id &&
        sameIdLegacy.spaceId === run.spaceId &&
        sameIdLegacy.kind === kind &&
        stableJsonValue(sameIdLegacy.request) === expectedRequest
      ) {
        consumedIds?.add(sameIdLegacy.id);
        await deps.events.append({
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: run.botId,
          type: "effect.reconciled",
          runId: run.id,
          payload: { executionId: candidate, kind, legacy: true },
        });
        return { duplicate: true, effect: sameIdLegacy };
      }
    }
  }

  // Only a pre-fix row can be the answer here, and the modern-key test is a cheap string
  // comparison while `stableJsonValue` serializes the whole stored request. This runs on every
  // tool call, so testing the key first keeps a long run from re-serializing its own history.
  const prior = await deps.prisma.externalEffect.findMany({
    where: { runId: run.id, spaceId: run.spaceId, kind },
    orderBy: { createdAt: "asc" },
  });
  const legacy =
    expectedRequest === undefined
      ? undefined
      : prior.find((candidate) => {
          if (consumedIds?.has(candidate.id)) return false;
          if (candidate.idempotencyKey === idempotencyKey) return false;
          if (
            candidate.runId !== run.id ||
            candidate.spaceId !== run.spaceId ||
            candidate.kind !== kind
          )
            return false;
          // Live later occurrences use a new modern key; do not steal an earlier modern row.
          if (isToolEffectIdempotencyKey(candidate.idempotencyKey, run.id, kind)) return false;
          try {
            return stableJsonValue(candidate.request) === expectedRequest;
          } catch {
            return false;
          }
        });
  if (legacy) {
    consumedIds?.add(legacy.id);
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      type: "effect.reconciled",
      runId: run.id,
      payload: { executionId: legacy.idempotencyKey, kind, legacy: true },
    });
    return { duplicate: true, effect: legacy };
  }

  const effect = await underRunLease(deps, run.id, (tx) =>
    tx.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind,
        idempotencyKey,
        status: "intended",
        request: request as never,
        ...(batchActions ? { batchActions } : {}),
      },
    }),
  );
  consumedIds?.add(effect.id);
  return { duplicate: false, effect };
}

/** Move an effect to executing. A superseded attempt is refused before its tool runs. */
export function claimEffect(
  deps: ExecutorDeps,
  runId: string,
  effectId: string,
  from: "approved" | "intended",
) {
  const claim = from === "approved" ? claimApprovedEffect : claimIntendedEffect;
  return underRunLease(deps, runId, (tx) => claim(tx, effectId));
}

/** Writes that let a tool's side effect go ahead check the attempt's lease in the same transaction. */
function underRunLease<T>(
  deps: ExecutorDeps,
  runId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const lease = runLeaseFor(deps, runId);
  if (!lease) return write(deps.prisma);
  return deps.prisma.$transaction(async (tx) => {
    await assertRunCanWriteHistory(tx, runId, { lease });
    return write(tx);
  });
}

export async function completeEffect(
  deps: ExecutorDeps,
  effectId: string,
  expectedStatus: "intended" | "executing",
  result: unknown,
) {
  const storedResult =
    result &&
    typeof result === "object" &&
    (result as { kind?: unknown }).kind === "agent_tool_result" &&
    "details" in result
      ? (result as { details: unknown }).details
      : result;
  return completeExternalEffect(deps.prisma, effectId, expectedStatus, storedResult as never);
}

export function uncertainEffectError(toolName: string): Error {
  return new Error(
    `tool ${toolName} has an earlier execution with an uncertain outcome; it may already have completed, so verify the destination before retrying`,
  );
}

/** Look up an already recorded effect by idempotency key without creating a row. */
export async function findRecordedEffect(
  deps: ExecutorDeps,
  idempotencyKey: string,
): Promise<{ status: string; request: unknown } | null> {
  if (!deps.prisma.externalEffect?.findUnique) return null;
  return deps.prisma.externalEffect.findUnique({
    where: { idempotencyKey },
    select: { status: true, request: true },
  });
}

function savedLoginSecretName(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("credentialSaved" in result)) return undefined;
  const saved = (result as { credentialSaved?: unknown }).credentialSaved;
  if (!saved || typeof saved !== "object") return undefined;
  const { name, auth } = saved as { name?: unknown; auth?: unknown };
  if (
    typeof name !== "string" ||
    !name ||
    !auth ||
    typeof auth !== "object" ||
    (auth as { type?: unknown }).type !== "login"
  ) {
    return undefined;
  }
  return name;
}

function pendingRequestSecretKind(
  runId: string,
  request: unknown,
  result: unknown,
): string | undefined {
  if (!request || typeof request !== "object") return runSecretKind(runId);
  const resolved = resolveRequestSecretDestination(request as Record<string, unknown>);
  if (resolved.oneTimeCodeOrigin) return runCodeKind(runId);
  if (resolved.destination) {
    const loginName = savedLoginSecretName(result);
    return loginName ? runLoginKind(runId, loginName) : undefined;
  }
  return runSecretKind(runId);
}

/**
 * Close an approved effect refused by the gate before its handler runs (e.g. a deny rule or
 * Never ask enabled after approval), so a later attempt does not reload it into approvedReplays.
 * For request_secret, also drop any pending answer stored for that card in the same transaction.
 */
export async function denyApprovedEffect(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; userId: string },
  idempotencyKey: string,
  refused: string,
  error?: string,
) {
  await underRunLease(deps, run.id, async (tx) => {
    if (!tx.externalEffect?.findUnique) return;
    const existing = await tx.externalEffect.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        runId: true,
        kind: true,
        request: true,
        result: true,
        status: true,
        createdAt: true,
      },
    });
    if (!existing || existing.runId !== run.id || existing.status !== "approved") return;
    const secretKind =
      existing.kind === "request_secret"
        ? pendingRequestSecretKind(run.id, existing.request, existing.result)
        : undefined;
    const createdAt = existing.createdAt;
    const updated = await tx.externalEffect.updateMany({
      where: { id: existing.id, status: "approved" },
      data: { status: "denied", result: error ? { refused, error } : { refused } },
    });
    if (updated && updated.count !== 1) return;
    if (secretKind && tx.secret?.deleteMany) {
      await tx.secret.deleteMany({
        where: {
          userId: run.userId,
          spaceId: run.spaceId,
          kind: secretKind,
          ...(createdAt instanceof Date ? { createdAt: { gte: createdAt } } : {}),
        },
      });
    }
  });
}
