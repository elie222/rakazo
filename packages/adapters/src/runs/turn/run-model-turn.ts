import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { modelRoleConnectionId } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, redactSecrets } from "@rakazo/core";
import { isDatabaseUnavailable, recordUsage } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isStrategicInitiativeRun } from "../../routines/strategic-initiative.js";
import { personSpeaker } from "../../runtime/context/history-speakers.js";
import { backgroundHelpersAllowed } from "../../tasks/background-helpers.js";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import { promptVersion } from "../assembly/prompt-version.js";
import type { AssembledTurn } from "../assembly/run-assembly.js";
import {
  botEmailInstruction,
  currentTurnDataPrompt,
  runIdentityInstruction,
  userTurnInstructions,
} from "../assembly/run-instructions.prompt.js";
import {
  GROUP_UNADDRESSED_REPLY_GUIDANCE,
  runReplyGuidance,
} from "../assembly/run-replies.prompt.js";
import type { RunExecutorServices, RunHold } from "../lifecycle/run-attempt.js";
import { completeRun } from "../lifecycle/run-complete.js";
import { failRun, handoffEndedTurn, requeueRunAfterDatabaseOutage } from "../lifecycle/run-fail.js";
import { searchRunTools } from "../tools/run-tool-search.js";
import { followUpsOffered, offeredFleetTools } from "../tools/run-tool-selection.js";
import { applyTool } from "../tools/run-tools.js";
import { loadPilotRuntime, pilotConversation, pilotGroupRequest } from "./primary-runtime-pilot.js";
import { consumeRunEvents } from "./run-turn.js";
import { claimRunSteering } from "./run-turn-images.js";
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
    const request = modelTurnRequest(services, hold, turn);
    const run = hold.run;
    const runtimeContext = {
      ...context,
      signal: AbortSignal.any([context.signal, ctx.runtimeAbortController.signal]),
    };
    const runtimeEvents = run.primaryRuntime
      ? (
          await loadPilotRuntime(
            { ...run, primaryRuntime: run.primaryRuntime },
            request.model,
            Boolean(turn.records.thread.groupId),
          )
        ).run(
          turn.records.thread.groupId
            ? await pilotGroupRequest(deps.prisma, {
                run: { ...run, primaryRuntime: run.primaryRuntime },
                thread: turn.records.thread,
                model: request.model,
                onUsage: request.onUsage,
                redactions: hold.secrets,
              })
            : {
                ...pilotConversation(
                  run,
                  turn.records.thread,
                  turn.records.bot,
                  turn.records.messages,
                ),
                botId: request.botId,
                threadId: request.threadId,
                runId,
                sourceMessageId: request.sourceMessageId,
                instructions: runIdentityInstruction(turn.records.bot, run.trigger),
                model: request.model,
                tools: [],
                onUsage: request.onUsage,
                secrets: request.secrets,
              },
          turn.records.thread.groupId ? { signal: runtimeContext.signal } : runtimeContext,
        )
      : deps.runtime.run(request, runtimeContext);
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
  const { strategicBuiltins, taskCatalogInstruction, tools, unavailableToolReasons } = turn.tools;
  const { computerInstruction, workspaceInstruction } = turn.computerInstructions;
  const {
    agentSkillsLine,
    botDirectory,
    hasHistoricalContext,
    pluginLine,
    prompt,
    runtimeHistory,
    resumeHistoryMessageIds,
    resumeAnswerReplyContexts,
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
  // The scripted runtime interprets the prompt as fixture commands.
  const currentTurnDataInPrompt =
    !scripted && (run.trigger === "user" || run.trigger === "follow_up");
  const redactedMemoryContext = memoryContext
    ? redactSecrets(memoryContext, runSecrets)
    : undefined;
  const redactedScratchpadContext = scratchpadContext
    ? redactSecrets(scratchpadContext, runSecrets)
    : undefined;
  // Keep these snapshots on the live turn. Replayed history comes from stored chat messages.
  const turnData = currentTurnDataInPrompt
    ? currentTurnDataPrompt(redactedMemoryContext, redactedScratchpadContext)
    : undefined;
  return {
    botId: bot.id,
    verbatimMcpServers,
    threadId: thread.id,
    runId,
    usageOperationKind: run.trigger === BACKGROUND_HELPER_TRIGGER ? "subagent" : "answer",
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
    prompt: turnData ? `${prompt}\n\n${turnData}` : prompt,
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
      redactedMemoryContext,
      redactedScratchpadContext,
      currentTurnDataInPrompt,
      redactedTicketContext: ticketContext ? redactSecrets(ticketContext, runSecrets) : undefined,
      hasHistoricalContext,
      // A background helper is not offered the history tools, so it gets no guidance on them.
      historyRetrievalEnabled:
        contextStrategy !== "current" && tools.some((tool) => tool.name === "search_history"),
      historyMyChats: ctx.source.myChatsAllowed,
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
      followUpsOffered: followUpsOffered(strategicBuiltins, ownerStartedRun, run.trigger),
      backgroundHelpersAllowed: backgroundHelpersAllowed({
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
    unavailableToolReasons,
    // The live array: secrets learned later in the run redact too.
    secrets: runSecrets,
    model: mainRunModel,
    computerModel,
    fallbackModels: fallbackModels.map((choice) => ({
      provider: choice.provider,
      id: choice.modelId,
      connectionId: modelRoleConnectionId(choice),
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
                  fallbackKey(
                    candidate.provider,
                    candidate.modelId,
                    modelRoleConnectionId(candidate),
                  ) === key,
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
    yieldSignal: deps.stoppingSignal,
    onCheckpoint: async (capture, executionId) => {
      effects.pendingTurnCheckpoints.set(executionId, capture);
    },
    resumeToolResult: {
      historyMessageIds: resumeHistoryMessageIds,
      content: [{ type: "text", text: takeoverResume?.promptNote ?? taskPrompt }],
    },
    script,
    allowSilentEmpty: allowSilentEmptyRun,
    emptyResponseText,
    executeTool: scripted
      ? undefined
      : (name, args, executionId, route, observer) =>
          applyTool(ctx, name, args, executionId, route, observer),
    searchTools: scripted ? undefined : (request) => searchRunTools(ctx, request),
    resolveModel: scripted
      ? undefined
      : (provider, modelId) =>
          resolveConnectedModel(run, provider, modelId, (values) => runSecrets.push(...values)),
    onTranscript: (transcript) => {
      state.reply.transcript = transcript;
    },
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
          resumeAnswerReplyContexts,
        },
      ),
  };
}
