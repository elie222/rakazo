import type {
  AdapterContext,
  DurableMemoryScope,
  SecretStore,
  TurnMemoryCapture,
  TurnMemoryCaptureResult,
  TurnMemoryToolCall,
  TurnMemoryToolResult,
} from "@rakazo/adapter-kit";
import { MEMORY_CAPTURE_MAX_ATTEMPTS } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText, redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  effectiveMemoryScope,
  encryptText,
  Prisma,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { isRetryableMemoryError } from "./memory-provider-factory.js";
import { isUserProgressClientNonce } from "./user-progress.js";

/**
 * Retire errors that a retry cannot repair. Otherwise one malformed turn permanently
 * blocks every later turn in the conversation. Only transient service/transport failures
 * keep the turn pending; logs identify the failure without reflecting stored evidence.
 */
class InvalidCaptureError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const CAPTURE_TURN_TIMEOUT_MS = 15_000;
export const MEMORY_CAPTURE_QUERY_MAX_CHARS = 8_000;
export const MEMORY_CAPTURE_ANSWER_MAX_CHARS = 16_000;
export const MEMORY_CAPTURE_TOOL_INPUT_MAX_CHARS = 2_000;
export const MEMORY_CAPTURE_TOOL_OUTPUT_MAX_CHARS = 4_000;
export const MEMORY_CAPTURE_MAX_TOOL_CALLS = 40;
export const MEMORY_CAPTURE_MAX_TOOL_RESULTS = 40;
export const MEMORY_CAPTURE_BATCH_SIZE = 25;
/**
 * A provider that answers "retryable" forever would otherwise keep one turn pending for
 * as long as its conversation lives. Six attempts is the queue's own budget, so an
 * exhausted turn is retired with a reason instead of blocking every later turn.
 */
export { MEMORY_CAPTURE_MAX_ATTEMPTS };

export interface CaptureTurnRunRow {
  id: string;
  spaceId: string;
  userId?: string;
  threadId: string;
  botId: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt?: Date;
  sourceMessageId: string | null;
  memoryCaptureDueAt: Date | null;
  memoryCapturedAt: Date | null;
  memoryRecallIds: unknown;
  memoryCaptureScope: string | null;
  memoryCaptureTarget?: string | null;
  memoryCapturePayload: unknown;
  memoryCaptureAttempts?: number;
}

export interface CaptureTurnSourceMessageRow {
  seq?: number;
  blocks: unknown;
}

export interface CaptureTurnBotMessageRow {
  blocks: unknown;
  clientNonce?: string | null;
}

export interface MemoryCapturePrisma {
  run: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        spaceId: true;
        userId: true;
        threadId: true;
        botId: true;
        status: true;
        startedAt: true;
        completedAt: true;
        createdAt: true;
        sourceMessageId: true;
        memoryCaptureDueAt: true;
        memoryCapturedAt: true;
        memoryRecallIds: true;
        memoryCaptureScope: true;
        memoryCaptureTarget: true;
        memoryCapturePayload: true;
        memoryCaptureAttempts: true;
      };
    }) => Promise<CaptureTurnRunRow | null>;
    findMany: (args: {
      where: Prisma.RunWhereInput;
      orderBy: Prisma.RunOrderByWithRelationInput[];
      take: number;
      select: { id: true };
    }) => Promise<Array<{ id: string }>>;
    updateMany: (args: {
      where: {
        id: string;
        memoryCapturedAt: null;
        memoryCapturePayload?: { equals: typeof Prisma.DbNull };
      };
      data:
        | { memoryCapturePayload: Prisma.InputJsonValue }
        | { memoryCaptureAttempts: { increment: number } };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: { memoryCapturedAt: Date; memoryCapturePayload: typeof Prisma.DbNull };
    }) => Promise<unknown>;
  };
  message: {
    findUnique?: (args: {
      where: { id: string };
      select: { seq: true; blocks: true };
    }) => Promise<CaptureTurnSourceMessageRow | null>;
    findFirst?: (args: {
      where: { id: string; threadId: string };
      select: { seq: true; blocks: true };
    }) => Promise<CaptureTurnSourceMessageRow | null>;
    findMany: (args: {
      where: { threadId: string; runId: string; role: "bot" };
      orderBy: { seq: "asc" };
      select: { blocks: true; clientNonce: true };
    }) => Promise<CaptureTurnBotMessageRow[]>;
  };
}

function asMessageBlocks(blocks: unknown): MessageBlock[] {
  return Array.isArray(blocks) ? (blocks as MessageBlock[]) : [];
}

function extractToolEvidence(messages: readonly CaptureTurnBotMessageRow[]): {
  toolCalls: TurnMemoryToolCall[];
  toolResults: TurnMemoryToolResult[];
} {
  const toolCalls: TurnMemoryToolCall[] = [];
  const toolResults: TurnMemoryToolResult[] = [];
  for (const message of messages) {
    for (const block of asMessageBlocks(message.blocks)) {
      if (block.kind === "steps" && Array.isArray(block.steps)) {
        for (const step of block.steps) {
          if (!step || typeof step !== "object" || typeof step.label !== "string") continue;
          const name = step.label.trim();
          if (!name) continue;
          // A step note is narration, not the arguments that invoked the tool.
          toolCalls.push({ name, input: "" });
        }
      } else if (block.kind === "subagent") {
        const name =
          typeof block.name === "string" && block.name.trim() ? block.name.trim() : "subagent";
        const input = typeof block.task === "string" ? block.task.trim() : "";
        toolCalls.push({ name, input });
        if (typeof block.result === "string" && block.result.trim()) {
          toolResults.push({ name, output: block.result.trim() });
        }
      }
    }
  }
  return { toolCalls, toolResults };
}

function extractBotAnswerText(messages: readonly CaptureTurnBotMessageRow[]): string {
  const progressParts: string[] = [];
  const finalParts: string[] = [];
  for (const message of messages) {
    const text = blocksToAgentHistoryText(asMessageBlocks(message.blocks)).trim();
    if (!text) continue;
    if (isUserProgressClientNonce(message.clientNonce ?? null)) progressParts.push(text);
    else finalParts.push(text);
  }
  if (finalParts.length > 0) return finalParts.join("\n\n");
  return progressParts.join("\n\n");
}

function parseRecallIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function safeCaptureText(text: string, limit: number, secrets: string[]): string {
  const redacted = redactSecrets(text, secrets);
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

/**
 * Pure builder for a finished turn's capture payload. Returns null when the turn has
 * neither a complete query/answer pair nor any tool evidence worth sending.
 */
export function buildTurnMemoryCapture(
  run: CaptureTurnRunRow,
  messages: {
    sourceMessage: CaptureTurnSourceMessageRow | null;
    botMessages: readonly CaptureTurnBotMessageRow[];
  },
  scope: DurableMemoryScope = "isolated",
  secrets: string[] = [],
): TurnMemoryCapture | null {
  const query = messages.sourceMessage
    ? blocksToAgentHistoryText(asMessageBlocks(messages.sourceMessage.blocks)).trim()
    : "";
  const answer = extractBotAnswerText(messages.botMessages);
  const { toolCalls, toolResults } = extractToolEvidence(messages.botMessages);
  const hasTools = toolCalls.length > 0 || toolResults.length > 0;
  if (!hasTools && (!query || !answer)) return null;

  const fallbackAt = run.completedAt ?? run.createdAt ?? new Date();
  if (!run.startedAt || !run.completedAt) {
    getLogger().warn("turn memory capture missing run timestamp", {
      runId: run.id,
      hasStartedAt: Boolean(run.startedAt),
      hasCompletedAt: Boolean(run.completedAt),
    });
  }
  const startedAt = (run.startedAt ?? run.createdAt ?? fallbackAt).toISOString();
  const completedAt = (run.completedAt ?? fallbackAt).toISOString();
  const seq = messages.sourceMessage?.seq;
  const sequence =
    typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;

  return {
    scope,
    botId: run.botId,
    threadId: run.threadId,
    runId: run.id,
    startedAt,
    completedAt,
    ...(sequence !== undefined ? { sequence } : {}),
    query: safeCaptureText(query, MEMORY_CAPTURE_QUERY_MAX_CHARS, secrets),
    answer: safeCaptureText(answer, MEMORY_CAPTURE_ANSWER_MAX_CHARS, secrets),
    toolCalls: toolCalls.slice(0, MEMORY_CAPTURE_MAX_TOOL_CALLS).map((call) => ({
      name: redactSecrets(call.name, secrets),
      input: safeCaptureText(call.input, MEMORY_CAPTURE_TOOL_INPUT_MAX_CHARS, secrets),
    })),
    toolResults: toolResults.slice(0, MEMORY_CAPTURE_MAX_TOOL_RESULTS).map((result) => ({
      name: redactSecrets(result.name, secrets),
      output: safeCaptureText(result.output, MEMORY_CAPTURE_TOOL_OUTPUT_MAX_CHARS, secrets),
    })),
    sourceMemoryIds: parseRecallIds(run.memoryRecallIds),
  };
}

interface CaptureDeps {
  prisma: MemoryCapturePrisma;
  memoryProviders: MemoryProviderResolver;
  secretStore?: Pick<SecretStore, "load">;
  lock?: <T>(
    key: string,
    run: () => Promise<T>,
  ) => Promise<{ acquired: true; value: T } | { acquired: false }>;
}

export type MemoryCaptureLock = NonNullable<CaptureDeps["lock"]>;

const capturePayloadSchema = z.object({
  scope: z.enum(["isolated", "shared"]),
  botId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  sequence: z.number().int().nonnegative().optional(),
  query: z.string(),
  answer: z.string(),
  toolCalls: z.array(z.object({ name: z.string(), input: z.string() })),
  toolResults: z.array(z.object({ name: z.string(), output: z.string() })),
  sourceMemoryIds: z.array(z.string()),
});

function captureLocation(run: CaptureTurnRunRow) {
  return {
    table: "runs",
    column: "memoryCapturePayload",
    rowId: run.id,
    owner: run.threadId,
  };
}

async function freezeCapturePayload(
  prisma: MemoryCapturePrisma,
  run: CaptureTurnRunRow,
  capture: TurnMemoryCapture,
): Promise<Prisma.InputJsonValue> {
  // This temporary outbox copy must use the same at-rest policy as message content.
  const ring = contentEncryptionOf(prisma)?.ring;
  if (ring?.encryptWrites) {
    return encryptText(
      await ring.current(run.spaceId),
      captureLocation(run),
      JSON.stringify(capture),
    );
  }
  return {
    ...capture,
    toolCalls: capture.toolCalls.map((call) => ({ ...call })),
    toolResults: capture.toolResults.map((result) => ({ ...result })),
  };
}

/**
 * Completion-only builder. Read the final reply and source under the finalizer's
 * thread lock, while the executing turn still owns its full in-memory redactions.
 * The only durable result is already redacted; no vault values or lists are retained.
 */
export async function buildCompletedTurnMemorySnapshot(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  runId: string,
  scope: DurableMemoryScope,
  sourceMemoryIds: string[],
  secrets: string[],
): Promise<Prisma.InputJsonValue | null> {
  const run = await readCaptureRun(tx as unknown as MemoryCapturePrisma, runId);
  if (run?.status !== "completed" || !run.completedAt || !run.sourceMessageId) return null;
  const [sourceMessage, botMessages] = await Promise.all([
    tx.message.findFirst({
      where: { id: run.sourceMessageId, threadId: run.threadId },
      select: { seq: true, blocks: true },
    }),
    tx.message.findMany({
      where: { threadId: run.threadId, runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
      select: { blocks: true, clientNonce: true },
    }),
  ]);
  const capture = buildTurnMemoryCapture(
    { ...run, memoryRecallIds: sourceMemoryIds },
    { sourceMessage, botMessages },
    scope,
    secrets,
  );
  if (!capture?.query.trim()) return null;
  return freezeCapturePayload(prisma, run, capturePayloadSchema.parse(capture));
}

/**
 * The frozen snapshot is this turn's only authoritative copy, so retiring it must stay
 * limited to evidence that can never become readable: a payload the schema rejects, a
 * key that belongs to another space, or a ciphertext that fails authentication. Reading
 * the key ring is a database call, so its failures stay retryable — a connection drop
 * must not delete the only copy of the turn.
 */
class InvalidCaptureSnapshotError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function openCapturePayload(prisma: MemoryCapturePrisma, run: CaptureTurnRunRow) {
  return readCapturePayload(prisma, run);
}

async function readCapturePayload(prisma: MemoryCapturePrisma, run: CaptureTurnRunRow) {
  const payload = run.memoryCapturePayload;
  const keyId = ciphertextKeyId(payload);
  if (!keyId) {
    const parsed = capturePayloadSchema.safeParse(payload);
    if (!parsed.success) throw new InvalidCaptureSnapshotError("invalid_capture_snapshot");
    return parsed.data;
  }
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Turn memory capture content encryption is unavailable");
  let key: Awaited<ReturnType<typeof ring.byId>>;
  try {
    key = await ring.byId(keyId);
  } catch (error) {
    // A key record that is gone can never be restored; anything else is the database.
    if (error instanceof Error && /no longer exists/.test(error.message)) {
      throw new InvalidCaptureSnapshotError("capture_snapshot_key_missing");
    }
    throw error;
  }
  if (!key) throw new InvalidCaptureSnapshotError("capture_snapshot_key_missing");
  if (key.spaceId !== run.spaceId) {
    throw new InvalidCaptureSnapshotError("capture_snapshot_space_mismatch");
  }
  let decrypted: string;
  try {
    decrypted = decryptText(key, captureLocation(run), payload as string);
  } catch {
    throw new InvalidCaptureSnapshotError("capture_snapshot_unreadable");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decrypted);
  } catch {
    throw new InvalidCaptureSnapshotError("invalid_capture_snapshot");
  }
  const parsed = capturePayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new InvalidCaptureSnapshotError("invalid_capture_snapshot");
  return parsed.data;
}

async function countCaptureFailure(prisma: MemoryCapturePrisma, runId: string) {
  // Connection/authentication faults affect the connection, not the validity of every
  // queued turn. Only individual delivery failures consume a turn's retry budget.
  await prisma.run.updateMany({
    where: { id: runId, memoryCapturedAt: null },
    data: { memoryCaptureAttempts: { increment: 1 } },
  });
}

async function markCaptureDone(prisma: MemoryCapturePrisma, runId: string) {
  // The snapshot is only needed until acknowledgement; don't retain a second content archive.
  await prisma.run.update({
    where: { id: runId },
    data: { memoryCapturedAt: new Date(), memoryCapturePayload: Prisma.DbNull },
  });
}

function readCaptureRun(prisma: MemoryCapturePrisma, runId: string) {
  return prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      threadId: true,
      botId: true,
      status: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      sourceMessageId: true,
      memoryCaptureDueAt: true,
      memoryCapturedAt: true,
      memoryRecallIds: true,
      memoryCaptureScope: true,
      memoryCaptureTarget: true,
      memoryCapturePayload: true,
      memoryCaptureAttempts: true,
    },
  });
}

function isPendingCapture(run: CaptureTurnRunRow | null): run is CaptureTurnRunRow {
  return (
    run?.status === "completed" && run.memoryCaptureDueAt != null && run.memoryCapturedAt == null
  );
}

/** Drains this conversation oldest-first, including old rows outside the reconciler's window. */
export async function captureFinishedTurn(deps: CaptureDeps, runId: string): Promise<void> {
  const run = await readCaptureRun(deps.prisma, runId);
  if (!isPendingCapture(run)) return;
  const drain = () => capturePendingTurns(deps, run);
  if (!deps.lock) {
    await drain();
    return;
  }
  const held = await deps.lock(`memory.capture:${run.threadId}:${run.botId}`, drain);
  if (!held.acquired) {
    // Another handler may pick this turn up, but it can also be releasing its lock after
    // an empty read. The durable capture obligation remains pending for the reconciler;
    // lock contention does not acknowledge the row or consume its delivery attempts.
    getLogger().debug("turn memory capture deferred: conversation busy", { runId: run.id });
  }
}

async function capturePendingTurns(deps: CaptureDeps, run: CaptureTurnRunRow): Promise<void> {
  const shared = run.memoryCaptureScope === "shared";
  // Keep batches bounded without dropping a triggering run beyond the first 25 rows.
  for (;;) {
    const pending = await deps.prisma.run.findMany({
      where: {
        status: "completed",
        threadId: run.threadId,
        // Shared memory still has one source conversation per bot. A failed bot's
        // turn must not hold up another bot's independent conversation.
        botId: run.botId,
        ...(shared
          ? { memoryCaptureScope: "shared" }
          : {
              OR: [{ memoryCaptureScope: "isolated" }, { memoryCaptureScope: null }],
            }),
        memoryCaptureDueAt: { not: null },
        memoryCapturedAt: null,
      },
      orderBy: [{ memoryCaptureDueAt: "asc" }, { id: "asc" }],
      take: MEMORY_CAPTURE_BATCH_SIZE,
      select: { id: true },
    });
    if (pending.length === 0) return;
    for (const row of pending) {
      const outcome = await captureOneTurn(deps, row.id);
      if (outcome === "deferred") return;
      if (outcome === "retryable") {
        // Order is what keeps a provider's conversation consistent, so a turn it cannot
        // take stops the drain. captureOneTurn retires a turn that exhausts its attempts,
        // so this cannot block the conversation forever.
        throw new Error(`Turn memory capture retryable: ${row.id}`);
      }
    }
    // No early return on a short batch: a turn that completed while this batch was being
    // read appears on the next query, and stopping here would lose its wakeup.
  }
}

async function captureOneTurn(
  deps: CaptureDeps,
  runId: string,
): Promise<"done" | "retryable" | "deferred"> {
  // The target (connection/thread/bot/scope/turnId) comes from stored rows, never later settings.
  const run = await readCaptureRun(deps.prisma, runId);
  if (!isPendingCapture(run)) return "done";
  if ((run.memoryCaptureAttempts ?? 0) >= MEMORY_CAPTURE_MAX_ATTEMPTS) {
    await markCaptureDone(deps.prisma, run.id);
    getLogger().warn("turn memory capture retired", {
      runId: run.id,
      reason: "capture_retry_exhausted",
    });
    return "done";
  }
  try {
    return await capturePendingTurn(deps, run);
  } catch (error) {
    if (
      error instanceof InvalidCaptureError ||
      error instanceof InvalidCaptureSnapshotError ||
      error instanceof z.ZodError
    ) {
      await markCaptureDone(deps.prisma, run.id);
      getLogger().warn("turn memory capture retired", {
        runId: run.id,
        reason:
          error instanceof InvalidCaptureError || error instanceof InvalidCaptureSnapshotError
            ? error.reason
            : "invalid_capture_payload",
      });
      return "done";
    }
    // Database and external-service outages must not erase the pending evidence.
    throw error;
  }
}

async function capturePendingTurn(
  deps: CaptureDeps,
  run: CaptureTurnRunRow,
): Promise<"done" | "retryable" | "deferred"> {
  if (!run.userId) throw new InvalidCaptureError("missing_capture_owner");
  // Today's vault cannot prove which values old evidence needs redacting. Never
  // rebuild a missing snapshot in a background worker, even when credentials exist.
  if (run.memoryCapturePayload == null) {
    throw new InvalidCaptureError("missing_capture_snapshot");
  }

  const availability = await deps.memoryProviders.resolveTurnMemory(run.spaceId);
  if (availability.kind === "unavailable") {
    if (!availability.retryable) {
      await markCaptureDone(deps.prisma, run.id);
      getLogger().warn("turn memory capture disabled", {
        runId: run.id,
        reason: availability.reason,
      });
      return "done";
    }
    getLogger().debug("turn memory capture provider unavailable", {
      runId: run.id,
      reason: availability.reason,
    });
    return "retryable";
  }
  if (availability.kind === "unconfigured") {
    getLogger().info("turn memory capture skipped: memory disconnected", {
      runId: run.id,
      spaceId: run.spaceId,
    });
    await markCaptureDone(deps.prisma, run.id);
    return "done";
  }

  // Unknown older targets cannot be assigned to today's connection. Both absent is
  // retained only for resolver implementations that do not expose connection identities.
  if ((run.memoryCaptureTarget ?? undefined) !== availability.captureTarget) {
    throw new InvalidCaptureError("capture_connection_changed");
  }

  const capture = await openCapturePayload(deps.prisma, run);
  if (!capture?.query.trim()) {
    getLogger().debug("turn memory capture skipped: empty query or evidence", { runId: run.id });
    await markCaptureDone(deps.prisma, run.id);
    return "done";
  }
  if (
    capture.runId !== run.id ||
    capture.botId !== run.botId ||
    capture.threadId !== run.threadId ||
    capture.scope !== effectiveMemoryScope(null, run.memoryCaptureScope ?? "isolated")
  ) {
    throw new InvalidCaptureError("capture_target_mismatch");
  }

  const context: AdapterContext = {
    operationId: `memory.capture:${run.id}`,
    traceId: run.id,
    spaceId: run.spaceId,
    userId: run.userId ?? "",
    botId: run.botId,
    runId: run.id,
    signal: AbortSignal.timeout(CAPTURE_TURN_TIMEOUT_MS),
  };

  const send = async (): Promise<TurnMemoryCaptureResult | null> => {
    // Recheck after the connection lease, key loading and other awaited work. A clear
    // revokes the durable obligation; it must not become an external acknowledgement.
    const current = await readCaptureRun(deps.prisma, run.id);
    if (!isPendingCapture(current) || current.memoryCapturePayload == null) return null;
    try {
      return await availability.lifecycle.captureTurn(capture, context);
    } catch (error) {
      if (isRetryableMemoryError(error)) {
        return { status: "retryable", reason: "provider_unavailable" };
      }
      throw new InvalidCaptureError("capture_provider_failure");
    }
  };
  // The resolver's connection guard is optional for provider-neutral fixtures. Database
  // failures in the guard stay outside the provider catch and must never retire evidence.
  const result = availability.captureConnection
    ? await availability.captureConnection(send)
    : await send();
  if (!result) return "deferred";
  if (
    result.status === "retryable" &&
    result.reason !== "unauthorized" &&
    result.reason !== "connection_not_found"
  ) {
    await countCaptureFailure(deps.prisma, run.id);
  }
  if (result.status === "stored" || result.status === "existing") {
    await markCaptureDone(deps.prisma, run.id);
    return "done";
  }
  if (result.status === "terminal") {
    getLogger().warn("turn memory capture rejected", {
      runId: run.id,
      reason: result.reason,
    });
    await markCaptureDone(deps.prisma, run.id);
    return "done";
  }
  return "retryable";
}
