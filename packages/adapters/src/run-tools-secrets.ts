import { runContinueJob } from "@rakazo/adapter-kit";
import { BotSecretName, botSecretSubmissionSchema } from "@rakazo/contracts";
import { createStreamingRedactor, displayName } from "@rakazo/core";
import { runLoginKind, runSecretKind } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  completeExternalEffect,
  replaceCompletedExternalEffectResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "./approval-effect.js";
import {
  allowPrivateHttpSecretOrigins,
  botSecretToolView,
  findBotSecret,
  findCommandVariableConflict,
  findRunLogin,
  forgetBotSecret,
  generateBotSecret,
  listBotSecrets,
  normalizeSecretDestination,
  requestedLoginFields,
  requestWithBotSecret,
  resolveRequestSecretDestination,
  sameSecretDestination,
} from "./bot-secrets.js";
import { addRunSecrets, pauseForSecret, persistTurnCheckpoint } from "./run-context.js";
import { recordEffect } from "./run-effects.js";
import { renewRunLease } from "./run-lifecycle.js";
import { notifyRun, secretAskNotification } from "./run-notifications.js";
import {
  commitConsumedRunSecret,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveMissingRunSecretAction,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** Saved credentials and protected input. */
export const secretTools: ToolHandlers = {
  async list_secrets(ctx) {
    const { deps, run } = ctx;
    return listBotSecrets(deps.prisma, run);
  },
  async forget_secret(ctx, call) {
    const { deps, run } = ctx;
    const { args } = call;
    const parsed = BotSecretName.safeParse(args.name);
    if (!parsed.success) return call.finish({ error: "A valid credential name is required." });
    // This run's unsaved login comes before a saved one of the name, as it does for fills.
    const forgotten = await deps.prisma.secret.deleteMany({
      where: { userId: run.userId, spaceId: run.spaceId, kind: runLoginKind(run.id, parsed.data) },
    });
    if (forgotten.count > 0) return call.finish({ removed: true });
    return call.finish(await forgetBotSecret(deps.prisma, run, parsed.data));
  },
  async generate_secret(ctx, call) {
    const { deps, run } = ctx;
    // Fills would type this run's unsaved login instead of the generated one.
    const held = await deps.prisma.secret.count({
      where: {
        userId: run.userId,
        spaceId: run.spaceId,
        kind: runLoginKind(run.id, String(call.args.name ?? "")),
      },
    });
    if (held > 0) {
      return call.finish({
        error: "This run holds a login under this name that wasn't saved. Use another name.",
      });
    }
    const { result, redactions } = await generateBotSecret({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      scope: run,
      args: call.args,
    });
    if (redactions) addRunSecrets(ctx, redactions);
    return call.finish(result);
  },
  async secret_request(ctx, call) {
    const { deps, run, context } = ctx;
    const { args } = call;
    try {
      const result = await requestWithBotSecret({
        prisma: deps.prisma,
        secretStore: deps.secretStore,
        scope: run,
        request: args,
        signal: context.signal,
        remote: deps.secretHttp,
        registerRedactions: (values) => addRunSecrets(ctx, values),
      });
      return call.finish(result);
    } catch {
      return call.finish({ error: "Invalid authenticated request." });
    }
  },
  async request_secret(ctx, call) {
    const { deps, run, runId, bot, thread, context } = ctx;
    const { name, args, executionId, effectKey, applied } = call;
    const { reply } = ctx.state;
    const resolvedSecret = resolveRequestSecretDestination(args);
    if (resolvedSecret.error) return call.finish({ error: resolvedSecret.error });
    const destination = resolvedSecret.destination;
    const connectionId = resolvedSecret.connectionId;
    const loginFields =
      destination?.auth.type === "login" ? requestedLoginFields(args.fields) : undefined;
    if (loginFields?.error) return call.finish({ error: loginFields.error });
    if (destination) {
      const existing = await findBotSecret(deps.prisma, run, destination.name);
      if (existing && !sameSecretDestination(existing, destination)) {
        return call.finish({
          error: "Remove the existing credential before changing its destination.",
        });
      }
      const conflict = await findCommandVariableConflict(deps.prisma, run, destination);
      if (conflict) {
        return call.finish({
          error: `Invalid credential destination — name: ${conflict} is already exported as the same variable. Choose another name.`,
        });
      }
      // A login the person chose not to save stays with this run; the bot is told so it doesn't
      // say it was saved. Field labels only, never values.
      const runLogin =
        destination.auth.type === "login"
          ? await findRunLogin(deps.prisma, deps.secretStore, run, runId, destination.name)
          : undefined;
      const known =
        runLogin && runLogin.origin === destination.origin
          ? {
              saved: false,
              ...destination,
              fields: runLogin.fields.map(({ label, hidden }) => ({ label, hidden })),
            }
          : existing
            ? { saved: true, ...botSecretToolView(existing) }
            : undefined;
      const submitted = botSecretSubmissionSchema({
        allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
      }).safeParse(applied?.effect.result).data;
      if (
        submitted &&
        sameSecretDestination(normalizeSecretDestination(submitted.credentialSaved), destination)
      ) {
        return call.finish(known ?? { error: "The saved credential is no longer available." });
      }
      if (known && args.replace !== true) return call.finish(known);
      // Action approval authorizes showing the card; it is not a credential submission.
      // Return the claim to intended so the answer transaction can approve the saved value.
      if (call.claimedEffect) {
        const released = await deps.prisma.externalEffect.updateMany({
          where: { id: applied!.effect.id, status: "executing" },
          data: { status: "intended" },
        });
        if (released.count !== 1) return uncertainEffectResult(name);
        call.claimedEffect = false;
      }
    }
    const secretKind = runSecretKind(runId);
    const storedSecret = await deps.prisma.secret.findFirst({
      where: {
        spaceId: run.spaceId,
        userId: run.userId,
        kind: secretKind,
      },
    });
    if (storedSecret) {
      const plaintext = await deps.secretStore.load(storedSecret.ciphertext, storedSecret.id);
      ctx.secrets.push(plaintext);
      // Keep the tail the old redactor still holds; a fresh instance drops it.
      reply.pendingProgress += reply.redactor.finish();
      reply.redactor = createStreamingRedactor(ctx.secrets);
      const purpose = String(args.purpose ?? "otp");
      if (applied && !call.claimedEffect) {
        if (applied.effect.status === "intended") {
          const early = await call.claimOrReturn("intended");
          if (early !== undefined) return early;
        } else if (applied.effect.status === "approved") {
          const early = await call.claimOrReturn("approved");
          if (early !== undefined) return early;
        }
      }
      const recordedEffect = await recordEffect(deps, run, name, effectKey, args);
      if (recordedEffect?.duplicate) {
        const gate = resolveDuplicateEffectGate(recordedEffect.effect, name);
        if (gate.action === "execute") {
          const early = await call.claimOrReturn("approved");
          if (early !== undefined) return early;
        }
      }
      // Claim executing (above), take the secret, then connector complete().
      // Retries without a secret reconcile via connectionReady / settle_attempt.
      return commitConsumedRunSecret({
        deleteSecret: async () => {
          await deps.prisma.secret.delete({
            where: { id: storedSecret.id },
          });
        },
        afterSecretTaken: async () => {
          let connectionResult: { connected: boolean; error?: string } | undefined;
          if (connectionId) {
            connectionResult = await tryCompleteConnectionWithCode(
              deps.prisma,
              deps.connectors,
              run,
              context,
              connectionId,
              plaintext,
            );
          }
          return purpose === "password" && !connectionId
            ? {
                ok: true,
                submitted: true,
                note: "The secret was not typed onto the computer. To reuse a website login, save it with auth type login and fill it with browser_act fill_secret; otherwise use request_takeover.",
              }
            : {
                ok: true,
                submitted: true,
                ...(connectionResult
                  ? {
                      connected: connectionResult.connected,
                      ...(connectionResult.error
                        ? { connectionError: connectionResult.error }
                        : {}),
                    }
                  : {}),
              };
        },
        persist: (secretResult) =>
          applied?.duplicate && applied.effect.status === "completed"
            ? replaceCompletedExternalEffectResult(deps.prisma, applied.effect.id, secretResult)
            : call.persistEffectResult(secretResult),
        onPersistFailed: uncertainEffectResult(name),
      });
    }
    const recordedForAsk = await recordEffect(deps, run, name, effectKey, args);
    const missingSecretAction = resolveMissingRunSecretAction(recordedForAsk.effect);
    if (missingSecretAction.action === "return") return missingSecretAction.result;
    if (connectionId) {
      const connectionStatus = await reconcileManagedConnection(
        deps.prisma,
        deps.connectors,
        run,
        context,
        connectionId,
      );
      if (connectionStatus === "connected") {
        const connectedResult = {
          ok: true,
          submitted: true,
          connected: true,
        };
        if (recordedForAsk.effect.status === "executing") {
          return (await completeExternalEffect(
            deps.prisma,
            recordedForAsk.effect.id,
            "executing",
            connectedResult,
          ))
            ? connectedResult
            : uncertainEffectResult(name);
        }
        return (await call.persistEffectResult(connectedResult))
          ? connectedResult
          : uncertainEffectResult(name);
      }
    }
    if (missingSecretAction.action === "settle_attempt") {
      // Secret was taken and connector may have consumed the OTP; do not re-ask.
      const failedAttempt = {
        ok: true,
        submitted: true,
        connected: false,
        connectionError: "Connection could not be completed.",
      };
      if (recordedForAsk.effect.status === "executing") {
        return (await completeExternalEffect(
          deps.prisma,
          recordedForAsk.effect.id,
          "executing",
          failedAttempt,
        ))
          ? failedAttempt
          : uncertainEffectResult(name);
      }
      return settleUncertainEffect(deps.prisma, recordedForAsk.effect.id, "request_secret");
    }
    if (!(await renewRunLease(deps, runId, ctx.workerId, ctx.fence))) {
      return pauseForSecret(ctx);
    }
    await ctx.computer.checkpoint.flush();
    await persistTurnCheckpoint(ctx, executionId);
    await ctx.settleRunningHelpers();
    const paused = await deps.events.pauseRunForInput({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId,
      attemptId: ctx.attempt.id,
      leaseOwner: ctx.workerId,
      leaseFence: ctx.fence,
      blocks: [
        {
          kind: "ask",
          text: String(args.label ?? "Code"),
          input: "secret",
          ...(destination ? { credential: destination } : {}),
          ...(loginFields?.labels ? { loginFields: loginFields.labels } : {}),
          purpose: normalizeSecretAskPurpose(args.purpose ? String(args.purpose) : undefined),
          status: "pending",
        },
      ],
    });
    if (!paused) {
      throw new Error("Could not pause this run for protected input; try sending again.");
    }
    if (paused.continuationRunId) {
      await deps.jobs
        .enqueue(runContinueJob(paused.continuationRunId))
        .catch((error) => getLogger().error("steering continuation enqueue", error));
    }
    await notifyRun(deps, run, {
      kind: "help",
      ...secretAskNotification(
        displayName(bot.name, "Bot"),
        String(args.label ?? "Code"),
        ctx.secrets,
      ),
      botId: bot.id,
      threadId: thread.id,
    });
    return pauseForSecret(ctx);
  },
};
