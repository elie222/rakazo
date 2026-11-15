import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { BACKGROUND_HELPER_TRIGGER, redactSecrets } from "@rakazo/core";
import { isDatabaseUnavailable, recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { backgroundHelpersAllowed } from "./background-helpers.js";
import { builtinAgentTools } from "./builtin.tool-definition.js";
import { personSpeaker } from "./history-speakers.js";
import { promptVersion } from "./prompt-version.js";
import type { AssembledTurn } from "./run-assembly.js";
import type { RunExecutorServices, RunHold } from "./run-attempt.js";
import {
  botEmailInstruction,
  runIdentityInstruction,
  userTurnInstructions,
} from "./run-instructions.prompt.js";
import { GROUP_UNADDRESSED_REPLY_GUIDANCE, runReplyGuidance } from "./run-replies.prompt.js";
import { followUpsOffered, offeredFleetTools } from "./run-tool-selection.js";
import { applyTool } from "./run-tools.js";
import {
  completeRun,
  consumeRunEvents,
  failRun,
  handoffEndedTurn,
  requeueRunAfterDatabaseOutage,
} from "./run-turn.js";
import { claimRunSteering } from "./run-turn-images.js";
import { isStrategicInitiativeRun } from "./strategic-initiative.js";
import { appendToolCompletionAudit, toolCompletionOutcome } from "./tool-completion-audit.js";
import { toolResultFingerprint } from "./tool-loop.js";
import { keepToolStepResult } from "./tool-step-calls.js";

export async function runModelTurn(
  services: RunExecutorServices,
  hold: RunHold,
  turn: AssembledTurn,
) {
  const { deps, runId, workerId, fence } = hold;
  const { checkpointLoadError } = turn.saved;
  const { context } = turn.connected;
  const { resolved } = turn.model;
  const { activeModel } = turn.fallbacks;
  const { ctx } = turn;
  const { state } = turn.ctx;
  // Shutdown must not finalize the attempt. The finally block queues the run
  // when this worker still owns it.
  const interruptedByShutdown = async () => {
    if (!deps.shutdownSignal?.aborted) return false;
    if (!ctx.state.terminalCheckpointComplete) {
      await ctx.computer.checkpoint.flush().catch(() => undefined);
    }
    return true;
  };
  try {
    if (checkpointLoadError) throw checkpointLoadError;
    // Recorded only once setup is done, so a setup failure is not charged to the prompt.
    // A label for comparing releases: failing to record it never fails the run.
    await Promise.resolve()
      .then(() =>
        deps.prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
          data: { promptVersion: promptVersion() },
        }),
      )
      .catch((error: unknown) => getLogger().warn("run.prompt_version_failed", { error }));
    const runtimeEvents = deps.runtime.run(modelTurnRequest(services, hold, turn), {
      ...context,
      signal: AbortSignal.any([context.signal, ctx.runtimeAbortController.signal]),
    });
    if (await consumeRunEvents(ctx, runtimeEvents)) return;
    if (await interruptedByShutdown()) return;
    await completeRun(ctx);
  } catch (turnError) {
    if (await interruptedByShutdown()) return;
    let caughtError = turnError;
    if (handoffEndedTurn(state, caughtError)) {
      try {
        await completeRun(ctx);
        return;
      } catch (completionError) {
        caughtError = completionError;
      }
    }
    if (isDatabaseUnavailable(caughtError)) {
      await requeueRunAfterDatabaseOutage(ctx);
      return;
    }
    await failRun(ctx, caughtError, {
      ownCredential: resolved.ownCredential,
      active: activeModel,
    });
  }
}

function modelTurnRequest(
  services: RunExecutorServices,
  hold: RunHold,
  turn: AssembledTurn,
): AgentRunRequest {
  const { contextStrategy, resolveConnectedModel } = services;
  const { deps, run, runId, workerId, fence, secrets: runSecrets } = hold;
  const { takeoverResume } = hold.takeover;
  const { checkpointModelResolver } = turn.saved;
  const { agentEnvironmentInstruction, bot, thread } = turn.records;
  const { context } = turn.connected;
  const { people, speakers } = turn.thread;
  const {
    allowSilentEmptyRun,
    currentRunRequiresImageInput,
    currentTurnImages,
    currentTurnMessage,
    emptyResponseText,
    groupReplyOptional,
    memoryContext,
    scratchpadContext,
    ticketContext,
    turnBlocks,
  } = turn.turnContext;
  const { scripted } = turn.model;
  const { currentTurnFiles, pendingTurnFiles } = turn.computer;
  const {
    botEmail,
    computerModel,
    disabledBuiltinTools,
    emailInbox,
    groupContext,
    mainRunModel,
    messagingContext,
    ownerStartedRun,
    pageBrowserAllowed,
    replyMode,
    sourceMessage,
    userComputer,
  } = turn.capabilities;
  const { strategicBuiltins, taskCatalogInstruction, tools } = turn.tools;
  const { computerInstruction, workspaceInstruction } = turn.computerInstructions;
  const {
    agentSkillsLine,
    botDirectory,
    historicalContext,
    pluginLine,
    prompt,
    runtimeHistory,
    taskPrompt,
    taughtSkillsLine,
    turnCheckpoint,
  } = turn.prompt;
  const {
    activeModel,
    fallbackKey,
    fallbackModelIds,
    fallbackModelKeys,
    fallbackModels,
    verbatimMcpServers,
  } = turn.fallbacks;
  const { ctx } = turn;
  const { script, state } = turn.ctx;
  const { effects } = turn.ctx.state;
  return {
    botId: bot.id,
    verbatimMcpServers,
    threadId: thread.id,
    runId,
    routineId: run.routineId,
    sourceMessageId: run.sourceMessageId,
    onUsage: async (event) => {
      await recordUsage(deps.prisma, event, {
        spaceId: run.spaceId,
        botId: bot.id,
        userId: run.userId,
        runId,
        parentRunId: runId,
        operationId: runId,
      });
    },
    prompt,
    ...(speakers &&
    (run.trigger === "user" || (run.trigger === "follow_up" && sourceMessage?.role === "user"))
      ? { promptSpeaker: personSpeaker(people, run.userId) }
      : {}),
    // Keep an explicit executor override, but let the runtime select
    // cache-aware context for connections declaring a cache window.
    contextStrategy: deps.contextStrategy,
    instructions: userTurnInstructions({
      botInstructions: [
        runIdentityInstruction(bot, run.trigger),
        botEmail
          ? botEmailInstruction(botEmail, {
              // Only the tools this bot has: its owner may turn any of them off.
              read: emailInbox && !disabledBuiltinTools.has("read_email"),
              send: emailInbox && Boolean(deps.email) && !disabledBuiltinTools.has("send_email"),
              delete: emailInbox && !disabledBuiltinTools.has("delete_email"),
            })
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      groupContext: groupReplyOptional
        ? [groupContext, GROUP_UNADDRESSED_REPLY_GUIDANCE].filter(Boolean).join("\n")
        : groupContext,
      messagingContext,
      redactedMemoryContext: memoryContext ? redactSecrets(memoryContext, runSecrets) : undefined,
      redactedScratchpadContext: scratchpadContext
        ? redactSecrets(scratchpadContext, runSecrets)
        : undefined,
      redactedTicketContext: ticketContext ? redactSecrets(ticketContext, runSecrets) : undefined,
      hasHistoricalContext: historicalContext.length > 0,
      // A background helper is not offered the history tools, so it gets no guidance on them.
      historyRetrievalEnabled:
        contextStrategy !== "current" && tools.some((tool) => tool.name === "search_history"),
      computerInstruction,
      pageBrowserAllowed,
      taskCatalogInstruction,
      workspaceInstruction,
      agentEnvironmentInstruction,
      botDirectory,
      pluginLine,
      agentSkillsLine,
      taughtSkillsLine,
      replyGuidance: runReplyGuidance(run.trigger, replyMode),
      // These runs get a narrow tool set, so guidance names only the tools they have.
      disabledBuiltinTools:
        isStrategicInitiativeRun(run) || run.trigger === BACKGROUND_HELPER_TRIGGER
          ? new Set(
              builtinAgentTools
                .map((tool) => tool.name)
                .filter((name) => !strategicBuiltins.some((tool) => tool.name === name)),
            )
          : disabledBuiltinTools,
      offeredFleetTools: offeredFleetTools(strategicBuiltins),
      followUpsOffered: followUpsOffered(strategicBuiltins, ownerStartedRun),
      backgroundHelpersAllowed: backgroundHelpersAllowed({
        threadBotId: thread.botId,
        botId: bot.id,
        trigger: run.trigger,
      }),
      userComputer,
    })
      .filter((instruction): instruction is string => Boolean(instruction))
      .join("\n\n"),
    history: runtimeHistory,
    currentTurnImages,
    currentRunRequiresImageInput,
    currentTurnImageFileFallback: Boolean(
      currentTurnImages?.length &&
        currentTurnFiles.length &&
        !turnBlocks?.some((block) => block.kind === "image" && block.imageHandling === "confirm"),
    ),
    tools,
    // The live array: secrets learned later in the run redact too.
    secrets: runSecrets,
    model: mainRunModel,
    computerModel,
    fallbackModels: fallbackModels.map(({ provider, modelId, credentialId }) => ({
      provider,
      id: modelId,
      ...(credentialId ? { connectionId: credentialId } : {}),
    })),
    resolveFallbackModel:
      checkpointModelResolver || fallbackModelKeys.size
        ? async (provider, modelId, connectionId) => {
            if (checkpointModelResolver?.has(provider, modelId, connectionId))
              return checkpointModelResolver(provider, modelId, connectionId);
            const key = fallbackKey(provider, modelId, connectionId);
            if (!fallbackModelKeys.has(key)) throw new Error("Backup model is not selected");
            return resolveConnectedModel(
              { userId: run.userId, spaceId: run.spaceId },
              provider,
              modelId,
              (values) => runSecrets.push(...values),
              true,
              fallbackModels.find(
                (candidate) =>
                  fallbackKey(candidate.provider, candidate.modelId, candidate.credentialId) ===
                  key,
              )?.thinkingLevel ?? null,
              connectionId,
            );
          }
        : undefined,
    onModelChange: async (provider, modelId, computerMode) => {
      const roleModel =
        [mainRunModel, computerModel].some(
          (model) => model?.provider === provider && model.id === modelId,
        ) || checkpointModelResolver?.hasModel(provider, modelId);
      if (!roleModel && !fallbackModelIds.has(fallbackKey(provider, modelId))) {
        throw new Error("Model is not selected");
      }
      // The run's model is what retries and pins rerun; computer mode is a detour from it.
      if (!computerMode) {
        const updated = await deps.prisma.run.updateMany({
          where: {
            id: runId,
            status: "running",
            leaseOwner: workerId,
            leaseFence: fence,
          },
          data: { modelProvider: provider, modelId },
        });
        if (updated.count !== 1) {
          throw new Error("Run lease was lost before the backup model could be used");
        }
      }
      activeModel["model.provider"] = provider;
      activeModel["model.id"] = modelId;
    },
    resumeFromCheckpoint: takeoverResume?.checkpoint,
    turnCheckpoint,
    onCheckpoint: async (capture, executionId) => {
      effects.pendingTurnCheckpoints.set(executionId, capture);
    },
    resumeToolResult: {
      content: [{ type: "text", text: takeoverResume?.promptNote ?? taskPrompt }],
    },
    script,
    allowSilentEmpty: allowSilentEmptyRun,
    emptyResponseText,
    executeTool: scripted
      ? undefined
      : (name, args, executionId, route, observer) =>
          applyTool(ctx, name, args, executionId, route, observer),
    resolveModel: scripted
      ? undefined
      : (provider, modelId) =>
          resolveConnectedModel(run, provider, modelId, (values) => runSecrets.push(...values)),
    onToolCompleted: (completion) => {
      if (effects.restoredPending?.executionId === completion.executionId)
        effects.restoredPending = undefined;
      if (!completion.paused) effects.pendingTurnCheckpoints.delete(completion.executionId);
      const outcome = toolCompletionOutcome(completion);
      if (outcome) state.reply.toolOutcomes.set(completion.executionId, outcome);
      keepToolStepResult(state.reply, completion, runSecrets);
      const audited = appendToolCompletionAudit(
        deps,
        {
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          runId,
        },
        completion,
        runSecrets,
      );
      state.toolResults.set(
        completion.executionId,
        toolResultFingerprint(completion.result, completion.error),
      );
      return audited;
    },
    claimSteering: (seenIds) =>
      claimRunSteering(
        deps,
        {
          threadId: thread.id,
          botId: bot.id,
          runId,
          leaseOwner: workerId,
          leaseFence: fence,
        },
        seenIds,
        context,
        pendingTurnFiles,
        {
          messageId: currentTurnMessage?.id,
          hasImages: Boolean(currentTurnImages?.length),
        },
      ),
  };
}
