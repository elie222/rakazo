import type { AdapterContext, ManagedConnectorProvider, SecretStore } from "@rakazo/adapter-kit";
import {
  BOT_SECRET_VALUE_MAX_LENGTH,
  encodeLoginSecret,
  loginAnswerValue,
  MessageBlock as MessageBlockSchema,
  normalizeOneTimeCode,
  SecretAskPurpose,
} from "@rakazo/contracts";
import { isSecretAskBlock } from "@rakazo/core";
import type { Prisma, PrismaClient, RunSecretWriter } from "@rakazo/db";
import { runCodeKind, runLoginKind, runSecretKind, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ApprovalPausedToolResult } from "./approval-effect.js";
import { internalTerminatingResult, resolveDuplicateEffectGate } from "./approval-effect.js";
import { encodeRunCode, encodeRunLogin, prepareBotSecret } from "./bot-secrets.js";
import { takeEmailedCode } from "./emailed-code.js";
import { persistPreparedSecret } from "./secret-persistence.js";

export function normalizeSecretAskPurpose(purpose: string | undefined): SecretAskPurpose {
  return SecretAskPurpose.safeParse(purpose).data ?? "otp";
}

export function secretPausedToolResult(): ApprovalPausedToolResult {
  return internalTerminatingResult({
    kind: "agent_tool_result",
    content: [{ type: "text", text: "Waiting for protected input." }],
    details: { secret: "paused" },
    terminate: true,
  });
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
        const login =
          ask.credential?.auth.type === "login"
            ? loginAnswerValue(ask.loginFields, input)
            : undefined;
        const code = ask.oneTimeCode ? normalizeOneTimeCode(input.answer) : undefined;
        if (
          input.answer.length > BOT_SECRET_VALUE_MAX_LENGTH ||
          (ask.oneTimeCode && !code) ||
          ((ask.credential || ask.oneTimeCode) && run.userId !== input.answeredByUserId) ||
          (ask.credential?.auth.type === "login"
            ? !login
            : input.username !== undefined || input.fields !== undefined)
        )
          return commit({
            store: async () => {
              throw new Error("Secret request changed; retry");
            },
          });
        const plaintext = login ? encodeLoginSecret(login) : (code ?? input.answer);
        const scope = { userId: run.userId, spaceId: input.spaceId, botId: run.botId };
        // With "Save to Vault" off, the login stays with this run, bound to the card's site.
        const runLogin =
          ask.credential?.auth.type === "login" && input.remember === false
            ? ask.credential
            : undefined;
        const prepared =
          ask.credential && !runLogin
            ? await prepareBotSecret({
                prisma,
                secretStore,
                scope,
                destination: ask.credential,
                plaintext,
                replaces: ask.replaces?.id,
              })
            : ask.oneTimeCode
              ? await sealRunCode(secretStore, scope, input.runId, {
                  origin: ask.oneTimeCode.origin,
                  code: plaintext,
                  fromEmail: input.fromEmail,
                })
              : await secretStore.put(
                  runLogin ? encodeRunLogin(runLogin.origin, plaintext) : plaintext,
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
                value.remember !== !runLogin ||
                JSON.stringify(value.credential) !== JSON.stringify(ask.credential) ||
                JSON.stringify(value.oneTimeCode) !== JSON.stringify(ask.oneTimeCode)
              )
                throw new Error("Secret request changed; retry");
              // Answering a login card again, saved or not, replaces this run's unsaved one.
              if (ask.credential?.auth.type === "login") {
                await value.tx.secret.deleteMany({
                  where: {
                    userId: run.userId,
                    spaceId: input.spaceId,
                    kind: runLoginKind(input.runId, ask.credential.name),
                  },
                });
              }
              if ("store" in prepared) await prepared.store(value.tx);
              else if (ask.oneTimeCode) await holdRunCode(value.tx, scope, input.runId, prepared);
              else
                await value.tx.secret.create({
                  data: {
                    id: prepared.id,
                    userId: run.userId,
                    spaceId: input.spaceId,
                    kind: runLogin
                      ? runLoginKind(input.runId, runLogin.name)
                      : runSecretKind(input.runId),
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

type RunScope = { userId: string; spaceId: string; botId: string };

/** Seal a code for this run's page. */
function sealRunCode(
  secretStore: SecretStore,
  scope: RunScope,
  runId: string,
  held: { origin: string; code: string; fromEmail?: string },
) {
  return secretStore.put(
    encodeRunCode(held.origin, held.code, held.fromEmail),
    { operationId: runId, traceId: runId, ...scope, signal: new AbortController().signal },
    { ephemeral: true },
  );
}

/** Keep a sealed code for the page; a newer one replaces a code the page has not taken yet. */
async function holdRunCode(
  tx: Prisma.TransactionClient,
  scope: RunScope,
  runId: string,
  sealed: { id: string; ciphertext: string },
) {
  const where = { userId: scope.userId, spaceId: scope.spaceId };
  await tx.secret.deleteMany({ where: { ...where, kind: runCodeKind(runId) } });
  return tx.secret.create({
    data: { id: sealed.id, ...where, kind: runCodeKind(runId), ciphertext: sealed.ciphertext },
  });
}

/** The request a code from mail was to answer was settled meanwhile: nothing was kept. */
export class SecretRequestNotOpen extends Error {
  constructor() {
    super("The secret request was settled before its code was kept");
    this.name = "SecretRequestNotOpen";
  }
}

/**
 * Take the code for a request from the bot's own inbox or the owner's connected mail
 * (takeEmailedCode) and keep it for this run's page, sealed and stored as the answer to a code
 * card is. The same transaction completes the request with `request.result`, what the call
 * returns, from the status the call holds it in: a call cut off right after is answered with that
 * result when retried, and leaves nothing approved for an attempt to replay. A request settled
 * meanwhile (SecretRequestNotOpen) rolls it all back. Nothing when there is no code. `hide` is
 * given the code once it is claimed, before that transaction commits: the attempt hides it from
 * then on, so nothing it writes while or after the code is kept can show it.
 */
export async function holdEmailedCode(
  prisma: PrismaClient,
  secretStore: SecretStore,
  input: Omit<Parameters<typeof takeEmailedCode>[1], "requestId"> & {
    scope: RunScope;
    request: { id: string; from: "intended" | "executing"; result: Prisma.InputJsonValue };
    hide: (code: string) => void;
  },
) {
  // The look is for that request: in whichever status the call holds it, it is the one asking.
  const look = { ...input, requestId: input.request.id };
  return takeEmailedCode(prisma, look, async (found, claim) => {
    const sealed = await sealRunCode(secretStore, input.scope, input.runId, {
      origin: input.origin,
      code: found.code,
      fromEmail: found.fromEmail,
    });
    let kept: Awaited<ReturnType<typeof holdRunCode>> | undefined;
    const commit = async () => {
      kept = await prisma.$transaction(async (tx) => {
        await claim(tx);
        input.hide(found.code);
        const row = await holdRunCode(tx, input.scope, input.runId, sealed);
        const { id, from, result } = input.request;
        const answered = await tx.externalEffect.updateMany({
          where: { id, runId: input.runId, kind: "request_secret", status: from },
          data: { status: "completed", result },
        });
        if (answered.count !== 1) throw new SecretRequestNotOpen();
        return row;
      });
      return kept;
    };
    const stored = await persistPreparedSecret(prisma, secretStore, sealed, commit).catch(
      (error: unknown) => {
        // The code is kept and its request answered: cleaning up after that failed, which must
        // not turn the fill into a card for a request already answered.
        if (!kept) throw error;
        getLogger().warn("emailed code was kept, but cleaning up after it failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return kept;
      },
    );
    return { ...found, stored };
  });
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
