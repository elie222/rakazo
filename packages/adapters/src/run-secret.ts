import type { AdapterContext, ManagedConnectorProvider, SecretStore } from "@rakazo/adapter-kit";
import {
  encodeLoginSecret,
  LoginSecretValue,
  MessageBlock as MessageBlockSchema,
  SecretAskPurpose,
} from "@rakazo/contracts";
import { isSecretAskBlock } from "@rakazo/core";
import type { PrismaClient, RunSecretWriter } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { type ApprovalPausedToolResult, resolveDuplicateEffectGate } from "./approval-effect.js";
import { prepareBotSecret } from "./bot-secrets.js";
import { persistPreparedSecret } from "./secret-persistence.js";

export function runSecretKind(runId: string): string {
  return `run-secret:${runId}`;
}

export function normalizeSecretAskPurpose(purpose: string | undefined): SecretAskPurpose {
  return SecretAskPurpose.safeParse(purpose).data ?? "otp";
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

export function createRunSecretWriter(secretStore: SecretStore): RunSecretWriter {
  return {
    async withPrepared(prisma, input, commit) {
      return withTransactionRetry(async () => {
        const run = await prisma.run.findFirst({
          where: {
            id: input.runId,
            spaceId: input.spaceId,
            threadId: input.threadId,
            status: "waiting_input",
          },
          select: { botId: true, userId: true },
        });
        const message = run
          ? await prisma.message.findFirst({
              where: {
                id: input.messageId,
                threadId: input.threadId,
                runId: input.runId,
                role: "bot",
              },
            })
          : null;
        const blocks = MessageBlockSchema.array().safeParse(message?.blocks);
        const ask = blocks.success
          ? blocks.data.find((block) => block.kind === "ask" && block.status !== "answered")
          : undefined;
        if (!run || ask?.kind !== "ask" || !isSecretAskBlock(ask))
          return commit({
            store: async () => {
              throw new Error("Secret request changed; retry");
            },
          });
        if (
          (ask.credential && run.userId !== input.answeredByUserId) ||
          (ask.credential?.auth.type === "login") !== Boolean(input.username?.trim()) ||
          (ask.credential?.auth.type === "login" &&
            !LoginSecretValue.safeParse({
              username: input.username?.trim(),
              password: input.answer,
            }).success)
        )
          return commit({
            store: async () => {
              throw new Error("Secret request changed; retry");
            },
          });
        const plaintext =
          ask.credential?.auth.type === "login"
            ? encodeLoginSecret({ username: input.username?.trim() ?? "", password: input.answer })
            : input.answer;
        const scope = { userId: run.userId, spaceId: input.spaceId, botId: run.botId };
        const prepared = ask.credential
          ? await prepareBotSecret({
              prisma,
              secretStore,
              scope,
              destination: ask.credential,
              plaintext,
            })
          : await secretStore.put(
              plaintext,
              {
                operationId: input.runId,
                traceId: input.runId,
                ...scope,
                signal: new AbortController().signal,
              },
              { ephemeral: true },
            );
        return persistPreparedSecret(prisma, secretStore, prepared, () =>
          commit({
            async store(value) {
              if (
                value.userId !== run.userId ||
                value.botId !== run.botId ||
                value.plaintext !== plaintext ||
                JSON.stringify(value.credential) !== JSON.stringify(ask.credential)
              )
                throw new Error("Secret request changed; retry");
              if ("store" in prepared) await prepared.store(value.tx);
              else
                await value.tx.secret.create({
                  data: {
                    id: prepared.id,
                    userId: run.userId,
                    spaceId: input.spaceId,
                    kind: runSecretKind(input.runId),
                    ciphertext: prepared.ciphertext,
                  },
                });
            },
          }),
        );
      });
    },
    async store() {
      throw new Error("Prepare secret material before opening a transaction");
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
