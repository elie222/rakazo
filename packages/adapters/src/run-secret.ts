import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { type ApprovalPausedToolResult, resolveDuplicateEffectGate } from "./approval-effect.js";
import type { EncryptedSecretStore } from "./secrets.js";

export function runSecretKind(runId: string): string {
  return `run-secret:${runId}`;
}

export function secretPausedToolResult(): ApprovalPausedToolResult {
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for protected input." }],
    details: { secret: "paused" },
    terminate: true,
  };
}

/**
 * Delete the stored secret before connector side effects, then persist the tool result.
 * Keeping the ciphertext until after complete() lets a crash retry resubmit a single-use OTP.
 * Callers must claim the effect to executing first and reconcile via connection status when
 * the secret is already gone on retry.
 */
export async function commitConsumedRunSecret<TResult, TFailed>(input: {
  deleteSecret: () => Promise<void>;
  afterSecretTaken: () => Promise<TResult>;
  persist: (result: TResult) => Promise<boolean>;
  onPersistFailed: TFailed;
}): Promise<TResult | TFailed> {
  await input.deleteSecret();
  const result = await input.afterSecretTaken();
  if (!(await input.persist(result))) return input.onPersistFailed;
  return result;
}

/**
 * When a completed request_secret effect still has a run-secret row, decide whether
 * that row is a crash leftover (same OTP, do not resubmit) or a newer replacement.
 */
export function resolveCompletedSecretLeftover(input: {
  secretCreatedAt: Date;
  effectUpdatedAt: Date;
}): "drop_leftover" | "consume_replacement" {
  return input.secretCreatedAt.getTime() <= input.effectUpdatedAt.getTime()
    ? "drop_leftover"
    : "consume_replacement";
}

/**
 * When the stored run secret is already gone, decide whether to reuse a settled
 * effect result, settle an in-flight attempt, or ask again.
 */
export function resolveMissingRunSecretAction(
  effect: { status: string; result?: unknown } | null | undefined,
):
  | { action: "return"; result: unknown }
  | { action: "uncertain"; toolName: string }
  | { action: "settle_attempt" }
  | { action: "ask" } {
  if (!effect) return { action: "ask" };
  const gate = resolveDuplicateEffectGate(effect, "request_secret");
  if (gate.action === "return") return { action: "return", result: gate.result };
  if (gate.action === "uncertain") {
    // executing means connector may already have consumed the OTP
    return { action: "settle_attempt" };
  }
  if (effect.status === "executing") return { action: "settle_attempt" };
  return { action: "ask" };
}

export async function reconcileManagedConnection(
  prisma: PrismaClient,
  connectors: { managed(id: string): ManagedConnectorProvider | undefined } | undefined,
  run: { spaceId: string; userId: string },
  context: AdapterContext,
  connectionId: string,
): Promise<"connected" | "pending" | "missing"> {
  const row = await prisma.connection.findFirst({
    where: {
      id: connectionId,
      spaceId: run.spaceId,
      userId: run.userId,
    },
  });
  if (!row) return "missing";
  if (row.status === "connected") return "connected";
  if (row.status !== "pending") return "missing";
  const connector = connectors?.managed(row.connectorId);
  if (!connector) return "pending";
  try {
    const ready = await connector.connectionReady(context, row.provider);
    if (ready) {
      await prisma.connection.update({
        where: { id: row.id },
        data: { status: "connected" },
      });
      return "connected";
    }
  } catch {
    return "pending";
  }
  return "pending";
}

export interface RunSecretWriter {
  store(input: {
    runId: string;
    userId: string;
    spaceId: string;
    plaintext: string;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}

export function createRunSecretWriter(secretStore: EncryptedSecretStore): RunSecretWriter {
  return {
    async store({ runId, userId, spaceId, plaintext, tx }) {
      const stored = await secretStore.put(plaintext, {
        operationId: runId,
        traceId: runId,
        spaceId,
        userId,
        signal: new AbortController().signal,
      });
      await tx.secret.create({
        data: {
          id: stored.id,
          userId,
          spaceId,
          kind: runSecretKind(runId),
          ciphertext: stored.ciphertext,
        },
      });
    },
  };
}

export async function tryCompleteConnectionWithCode(
  prisma: PrismaClient,
  connectors: { managed(id: string): ManagedConnectorProvider | undefined } | undefined,
  run: { spaceId: string; userId: string },
  context: AdapterContext,
  connectionId: string,
  code: string,
): Promise<{ connected: boolean; error?: string }> {
  const row = await prisma.connection.findFirst({
    where: {
      id: connectionId,
      spaceId: run.spaceId,
      userId: run.userId,
      status: { in: ["pending", "connected"] },
    },
  });
  if (!row) return { connected: false };
  // Already finished on a prior attempt; do not resubmit the OTP.
  if (row.status === "connected") return { connected: true };
  const connector = connectors?.managed(row.connectorId);
  if (!connector) return { connected: false };
  const state = row.providerRef ?? row.provider;
  try {
    await connector.complete({ state, code }, context);
    const ready = await connector.connectionReady(context, row.provider);
    if (ready) {
      await prisma.connection.update({
        where: { id: row.id },
        data: { status: "connected" },
      });
    }
    return { connected: ready };
  } catch {
    return {
      connected: false,
      error: "Connection could not be completed.",
    };
  }
}
