import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentToolExecutionObserver,
  AutoReviewRequest,
  ComputerRef,
  ConnectorCall,
  ConnectorTool,
  SandboxProvider,
  SemanticMemoryProvider,
} from "@rakazo/adapter-kit";
import {
  DEFAULT_CONTEXT_STRATEGY,
  historyCompactJob,
  MEMORY_REVISION_CONFLICT_ERROR,
  ModelAccountError,
  ModelOutputError,
  runContinueJob,
  SandboxRateLimitError,
  TransientModelError,
} from "@rakazo/adapter-kit";
import type { ComputerCommand, MessageBlock, ModelRoleChoice, RunStatus } from "@rakazo/contracts";
import {
  ATTACHMENT_MAX_BYTES,
  BotSecretName,
  botSecretSubmissionSchema,
  COMPUTER_COMMAND_OUTPUT_MAX_CHARS,
  disabledBuiltinToolSet,
  HistoryReadInputSchema,
  HistorySearchInputSchema,
} from "@rakazo/contracts";
import type { ToolCallStreak } from "@rakazo/core";
import {
  appendTextSegment,
  appendToolCallSegment,
  applyJudgeDecision,
  approvalModeFromPreference,
  assertTransition,
  botMessageAllowsSilence,
  composioBatchActions,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  containsSecret,
  createStreamingRedactor,
  displayName,
  endsSentence,
  expandSkillReferencesInPrompt,
  formatSkillRunPrompt,
  formatSkillsCatalogInstruction,
  humanizeToolName,
  inferAttachmentMimeType,
  isBackgroundRunTrigger,
  isCallClientNonce,
  isMessagingChannelRun,
  isOwnerStartedRun,
  isTerminal,
  MISSING_MODEL_RUN_ERROR,
  messagingChannelId,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  newSiteOutcome,
  nextFence,
  outboundSiteGate,
  planActionGate,
  promptInvokesSkill,
  redactSecrets,
  renderBotDirectory,
  resolveActionApprovalForTools,
  sandboxCommandTimeoutMs,
  TAKEOVER_COMPUTER_PENDING_STATE,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
  userRunError,
  userTurnMessageForRun,
} from "@rakazo/core";
import { normalizedHttpUrl, urlSite } from "@rakazo/core/egress";
import { approvalEffectKey, toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import {
  createSpaceForMember,
  dropRunTurnCheckpoint,
  effectiveMemoryScope,
  InstructionConflictError,
  InvalidSpaceNameError,
  isPartialReplyClientNonce,
  isTooManyDatabaseConnections,
  loadRunHistoryMessages,
  loadRunTurnCheckpoint,
  parseComputerMode,
  RunHistoryWriteError,
  readHistory,
  readRunTimingFields,
  recordUsage,
  reserveInstructionProposal,
  runAsSystem,
  runSecretKind,
  SpaceLimitError,
  saveRunTurnCheckpoint,
  searchHistory,
  settleReleasedTakeoverCards,
  validateInstructionProposal,
  writeBotInstructions,
} from "@rakazo/db";
import { enrichLogContext, getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import {
  connectAgent,
  messageConnectedAgent,
  prepareAgentConnectionResponse,
  respondAgentConnection,
} from "./agent-connections.js";
import {
  decryptAgentEnvironment,
  formatAgentEnvironmentInstruction,
  redactShellStreams,
} from "./agent-environment.js";
import type { FleetCardSummary } from "./approval-ask.js";
import { buildApprovalAskBlock, MAX_FETCH_URL_LENGTH } from "./approval-ask.js";
import type { ApprovalPausedToolResult } from "./approval-effect.js";
import {
  approvalPausedToolResult,
  approvalReplayPathError,
  approvalReplayResourceError,
  approvalRoutesMatch,
  approvedCatalogReplay,
  approvedEffectOccurrence,
  approvedReplayArgs,
  boundDirectApprovalDetails,
  boundDirectApprovalRequest,
  catalogApprovalDetails,
  catalogApprovalInnerArgs,
  catalogApprovalMatchesLiveRoute,
  catalogApprovalRequest,
  claimApprovedEffect,
  claimIntendedEffect,
  completeExternalEffect,
  createApprovedEffectReplayQueue,
  isToolPauseResult,
  replaceCompletedExternalEffectResult,
  resolveDuplicateEffectGate,
  settleUncertainEffect,
  uncertainEffectResult,
} from "./approval-effect.js";
import type { AutoReviewChecker } from "./auto-review.js";
import {
  isAutoReviewCheckerConfigured,
  redactToolArgsForReview,
  resolveAutoReviewChecker,
} from "./auto-review.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import { PARTIAL_REPLY_NOTE } from "./automated-messages.js";
import { loadBotMessageContext, messageBot, returnBotMessageOutcome } from "./bot-messages.js";
import {
  allowPrivateHttpSecretOrigins,
  botSecretToolView,
  commandCredentialRedactions,
  findBotSecret,
  findCommandVariableConflict,
  forgetBotSecret,
  listBotSecrets,
  loadBotCommandEnvironment,
  loadLoginPasswordRedactions,
  normalizeSecretDestination,
  requestWithBotSecret,
  resolveLoginFill,
  resolveRequestSecretDestination,
  sameSecretDestination,
  shellCommandEnvironment,
} from "./bot-secrets.js";
import { createBrowserProvider } from "./browser-provider-factory.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
} from "./browser-tools.js";
import { agentConnectionTools, builtinAgentTools, sharedMemorySaveError } from "./builtin-tools.js";
import { endCallFromTool, requestUserCall } from "./call-request.js";
import { archiveSpawnedBot, spawnBot } from "./child-bots.js";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { executeCloudAgentTool } from "./cloud-agent-service.js";
import { validCloudAgentArgs } from "./cloud-agent-tools.js";
import { collectLogIds, mergeConnectedPlugins, needsLivePluginSync } from "./composio-connector.js";
import { BACKGROUND_WORK_LAUNCH, scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import {
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";
import type { UnchangedVisualStreak } from "./computer-tools.js";
import {
  advanceUnchangedVisualGuard,
  computerVisualActionKey,
  observationToolResult,
  parseComputerActions,
  unchangedVisualActionBlocked,
  unchangedVisualLoopToolResult,
  unchangedVisualStreakAfterPageBrowser,
} from "./computer-tools.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import { connectApp } from "./connect-app.js";
import {
  connectedContext,
  loadLivePluginSlugs,
  persistLivePluginConnections,
  selectRunConnections,
} from "./connection-context.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import {
  desktopProtectionGuardMessage,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import { protectedActivateScriptWriteRefusal } from "./desktop-guard-words.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FleetRun } from "./fleet-tools.js";
import {
  createChildRoutine,
  createFleetGroup,
  isFleetApprovalTool,
  listFleet,
  organizeBot,
  prepareFleetRequest,
  setChildBotModel,
  setChildInstructions,
  updateChildBot,
  updateFleetGroup,
  updateOwnBotFromTool,
} from "./fleet-tools.js";
import { handoffToGroupBot, loadBotGroupDirectory, loadGroupContext } from "./group-handoff.js";
import {
  COMPACTION_BATCH_SIZE,
  formatCompactedSummary,
  formatRecalledMemory,
  HISTORY_WINDOW_SIZE,
  historyWindowSize,
  LEGACY_HISTORY_WINDOW_SIZE,
  MAX_RECALLED_MEMORIES,
  selectCompactedHistory,
  shouldEnqueueCompaction,
} from "./history-compaction.js";
import { assertConnectorToolArgs, CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { addMcpServerFromTool } from "./mcp-server-tool.js";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { generateMediaFromTool } from "./media-generation-tools.js";
import { loadAgentMemoryContext } from "./memory-context.js";
import { appendMemoryFact } from "./memory-tools.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";
import {
  effectiveModelRole,
  resolveMemberMainModel,
  selectConfiguredModel,
} from "./model-roles.js";
import {
  findConnectedModelCredential,
  PINNED_PROVIDER_NOT_CONNECTED,
  pinnedModelCredentialError,
  runModelChoice,
} from "./model-selection.js";
import {
  IMAGE_RETURNING_COMPUTER_TOOLS,
  MODEL_CANNOT_SEE_MESSAGE,
  modelAcceptsImageInput,
} from "./model-vision.js";
import { nativeShellCommandArgv } from "./native-shell.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import { namedAgentTools } from "./pi-runtime-tools.js";
import { loadReplyContext, messageToAgentHistoryText } from "./reply-context.js";
import {
  backOffRoutineAfterAccountError,
  clearRoutineBackoff,
  isModelAccountRefusal,
} from "./routine-backoff.js";
import { lateRoutineRunInstruction } from "./routine-lateness.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import { lazyRunComputer } from "./run-computer.js";
import {
  APPROVED_EFFECT_REPLAY_ORDER,
  approvalReplayEffectToolName,
  buildApprovalContinuation,
  CATALOG_APPROVAL_TOOL,
  completeEffect,
  isSubagentToolExecution,
  recordEffect,
  runScopedToolExecutionId,
  uncertainEffectError,
} from "./run-effects.js";
import {
  BOT_DIRECTORY_LIMIT,
  builtinOffered,
  dockerComputerToolInstruction,
  persistentComputerInstruction,
  runIdentityInstruction,
  threadContextForRun,
  userTurnInstructions,
  voiceCallInstruction,
} from "./run-instructions.js";
import {
  computerRetryDelay,
  computerScreenToolResult,
  createRunWorkspaceCheckpoint,
  failRunBeforeTurn,
  mayOpenModelStream,
  RUN_SETUP_FAILURE_LIMIT,
  renewRunLease,
  requeueComputerRun,
  setupFailureStreak,
  writeComputerRunRequeue,
} from "./run-lifecycle.js";
import { persistMessageInTransaction, publishMessage, redactBlocks } from "./run-messages.js";
import {
  cloudflareRunFields,
  fleetPrepareDeps,
  isTerminalModelSetupError,
  modelCreditBillingEnabled,
  resolveConnectedRunModel,
  resolveModelKey,
  resolveRunModel,
  runtimeFallbackModel,
} from "./run-model.js";
import {
  completionMarksUnread,
  completionNotificationBody,
  completionNotificationPreview,
  notifyRun,
  runSendsFinishNotification,
  secretAskNotification,
  subagentMarksUnread,
} from "./run-notifications.js";
import {
  completionMessageSegments,
  DELEGATED_EMPTY_NOTICE,
  emptyDelegatedToolTurnShouldFail,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
  runReplyGuidance,
  TOOL_STEPS_WITHOUT_RESPONSE,
} from "./run-replies.js";
import {
  notifyRoutineRetryAttemptsExhausted,
  retryRoutineRun,
  scheduleRoutineRetry,
  wakeRoutine,
} from "./run-routines.js";
import {
  commitConsumedRunSecret,
  normalizeSecretAskPurpose,
  reconcileManagedConnection,
  resolveCompletedSecretLeftover,
  resolveMissingRunSecretAction,
  secretPausedToolResult,
  tryCompleteConnectionWithCode,
} from "./run-secret.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  FLEET_WRITE_TOOL_NAMES_SET,
  offeredFleetTools,
  PAGE_BROWSER_TOOL_NAMES,
  READ_ONLY_AGENT_TOOLS,
  selectBuiltinToolsForRun,
} from "./run-tool-selection.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";
import {
  claimRunSteering,
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  RECENT_TURN_IMAGE_TURNS,
  withRecentTurnImages,
} from "./run-turn-images.js";
import { withRuntimeCleanup } from "./runtime-stream.js";
import {
  cancelScheduleFromTool,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  isScheduleValueProvided,
  listSchedulesFromTool,
  updateScheduleFromTool,
} from "./schedule-tools.js";
import { loadAgentScratchpadContext } from "./scratchpad-context.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  listScratchpadItemsFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "./scratchpad-tools.js";
import { inferScript } from "./scripted-runtime.js";
import {
  isRunningShellCommand,
  observeShellCommand,
  SHELL_STILL_RUNNING_NOTICE,
} from "./shell-command-stream.js";
import { isExactNoResponse, stripNoResponseReply, stripStrayNoResponse } from "./silent-reply.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";
import {
  continueRunClaimFence,
  DESKTOP_HELD_FOR_TAKEOVER_MESSAGE,
  refreshTakeoverContinuePlan,
  takeoverCheckpointOf,
  takeoverContinuePlan,
} from "./takeover-resume.js";
import { TASK_CATALOG_GUIDANCE, taskCatalogFromTool } from "./task-catalog.js";
import { getActiveTeachingSession, parsePlaybook } from "./teaching-session.js";
import {
  attachWorkspaceFileToThread,
  currentTurnFilesInstruction,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeRecentThreadFiles,
  recentThreadFilesInstruction,
} from "./thread-artifacts.js";
import { loadAgentTicketContext } from "./ticket-context.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "./ticket-tools.js";
import { appendToolCompletionAudit, toolCompletionFromResult } from "./tool-completion-audit.js";
import { advanceToolCallLoopGuard, loopGuardStopText } from "./tool-loop.js";
import { textContentArg } from "./tool-text.js";
import { restoreTurnCheckpoint, unresolvedTurnCheckpointCalls } from "./turn-checkpoint.js";
import { argumentGiven } from "./update-bot-patch.js";
import {
  assistantTurnSeparator,
  botMessageOutcomeFromMidTurn,
  clampUserProgressMessage,
  extractNarrationText,
  finalBlocksAfterMidTurnProgress,
  isProgressMessageTruncated,
  isUserProgressClientNonce,
  messageUserMaxLength,
  midTurnProgressBudgetAllows,
  userProgressClientNonce,
} from "./user-progress.js";
import { createWebProvider } from "./web-provider-factory.js";
import { webFetchFromTool, webSearchFromTool } from "./web-tools.js";
import type { RunWorkspace } from "./workspace-file-tools.js";
import { listFilesFromTool, readFileFromTool, renderPlotFromTool } from "./workspace-file-tools.js";

export function createRunExecutor(deps: ExecutorDeps) {
  const contextStrategy = deps.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY;
  const web = deps.web ?? createWebProvider();
  const mediaGeneration = deps.mediaGeneration ?? createMediaGenerationProvider();
  const browser = deps.browser ?? createBrowserProvider(undefined, { sandbox: deps.sandbox });
  const cloudAgent = deps.cloudAgent;
  const resolveConnectedModel = resolveConnectedRunModel.bind(undefined, deps);
  return {
    resolveConnectedModel,
    contextStrategy,
    resolveModel: resolveRunModel.bind(undefined, deps),
    wakeRoutine: wakeRoutine.bind(undefined, deps),
    notifyRoutineRetryAttemptsExhausted: notifyRoutineRetryAttemptsExhausted.bind(undefined, deps),
    retryRoutineRun: retryRoutineRun.bind(undefined, deps),

    async continueRun(runId: string, workerId: string, onRunStarted?: () => void) {
      const run = await deps.prisma.run.findUnique({ where: { id: runId } });
      if (!run) return;
      // Logs and security events raised by this run's tools name its account and space.
      enrichLogContext({
        "run.id": runId,
        "bot.id": run.botId,
        "thread.id": run.threadId,
        "space.id": run.spaceId,
        ...(run.userId ? { "user.id": run.userId } : {}),
      });
      if (isTerminal(run.status as RunStatus)) return;
      let { resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume } =
        takeoverContinuePlan(run);

      const fence = nextFence(run.leaseFence);
      const now = new Date();
      const leased = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          ...continueRunClaimFence(run),
          AND: [{ OR: [{ wakeAt: null }, { wakeAt: { lte: now } }] }],
          OR: [
            { status: { in: ["queued", "waiting_input", "waiting_takeover"] } },
            {
              status: { in: ["leased", "running"] },
              leaseExpiresAt: { lte: now },
            },
          ],
        },
        data: {
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
          leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
          error: null,
          checkpoint: null,
          wakeAt: null,
        },
      });
      if (leased.count !== 1) return;

      const current = await deps.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      if (
        current.status === "queued" ||
        current.status === "leased" ||
        current.status === "waiting_input" ||
        current.status === "waiting_takeover"
      ) {
        assertTransition(current.status as RunStatus, "running");
      }
      const started = await deps.prisma.run.updateMany({
        where: {
          id: runId,
          status: "leased",
          leaseOwner: workerId,
          leaseFence: fence,
        },
        data: { status: "running" },
      });
      if (started.count !== 1) return;
      const leaseTarget = await deps.prisma.bot.findUniqueOrThrow({
        where: { id: run.botId },
        select: {
          computerId: true,
          computerSwitching: true,
          computer: { select: { scope: true } },
        },
      });
      if (!leaseTarget.computerId) throw new Error("Bot has no computer");
      if (leaseTarget.computerSwitching) {
        await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
        return;
      }
      if (takeoverResume) {
        await settleReleasedTakeoverCards(
          deps.prisma,
          {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            runId,
            reason: takeoverResume.checkpoint,
          },
          (threadId, seq) => deps.events.notify(threadId, seq),
        );
      }
      let computerLease: ComputerExecutionLease | null = null;
      try {
        computerLease = await acquireComputerExecutionLease(deps.prisma, {
          computerId: leaseTarget.computerId,
          runId,
          botId: run.botId,
          resumeHeldLease,
        });
        if (!computerLease && leaseTarget.computer?.scope === "dedicated") {
          computerLease = await acquireDedicatedScreenLeaseFence(deps.prisma, {
            computerId: leaseTarget.computerId,
            runId,
            botId: run.botId,
            workerId,
            runFence: fence,
          });
        }
      } catch (error) {
        if (!(error instanceof ComputerBusyError)) throw error;
        await requeueComputerRun(deps, runId, workerId, fence, resumeCheckpoint, heldForTakeover);
        return;
      }
      let attempt: { id: string };
      // Resumed attempts keep the first start, so lateness reflects when the run began.
      const executionStartedAt = current.startedAt ?? new Date();
      try {
        // Acquiring the computer can requeue a busy run. Count that wait as queue
        // time, and only stamp execution once this attempt can use its computer.
        const executionStarted = await deps.prisma.run.updateMany({
          where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
          data: { startedAt: executionStartedAt },
        });
        if (executionStarted.count !== 1) {
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
          return;
        }
        getLogger().info("run.execution_started", {
          ...(await readRunTimingFields(deps.prisma, runId)),
        });
        attempt = await deps.prisma.attempt.create({
          data: { runId, fence, status: "running" },
        });
      } catch (error) {
        await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
        throw error;
      }

      let leaseValid = true;
      let runCompleted = false;
      let lastLeaseCheckAt = 0;
      let retainComputerLease = false;
      let computerUseReason: "none" | "tool" | "takeover" | "script" = "none";
      let computerUseTool: string | undefined;
      let screenRelease:
        | { computer: ComputerRef; context: AdapterContext; keepWarm: boolean }
        | undefined;
      let runAbortController: AbortController | null = null;
      // Runtime cleanup can queue terminal events after the consumer has exited.
      // Track only helpers whose running state this attempt actually persisted.
      const runningHelpers = new Map<
        string,
        Omit<Extract<MessageBlock, { kind: "subagent" }>, "kind">
      >();
      const settleRunningHelpers = async () => {
        for (const [agentId, block] of runningHelpers) {
          try {
            const stopped = {
              ...block,
              kind: "subagent",
              status: "failed",
              result: "stopped",
            } as const;
            await publishMessage(
              deps,
              run,
              "bot",
              [stopped],
              subagentMarksUnread(run.trigger, "failed"),
              undefined,
              stopped,
            );
            runningHelpers.delete(agentId);
          } catch (error) {
            // Cleanup must not mask the run outcome or prevent other helpers settling.
            getLogger().error("settle running helper", error);
          }
        }
      };

      let detachShutdown: (() => void) | undefined;
      const heartbeat = setInterval(() => {
        if (runCompleted) return;
        void Promise.all([
          renewRunLease(deps, runId, workerId, fence),
          renewComputerExecutionLease(deps.prisma, computerLease),
        ])
          .then(([runRenewed, computerRenewed]) => {
            if (runCompleted) return;
            if (!runRenewed || !computerRenewed) {
              leaseValid = false;
              runAbortController?.abort();
            }
          })
          .catch(() => {
            if (runCompleted) return;
            leaseValid = false;
            runAbortController?.abort();
          });
      }, 60_000);
      heartbeat.unref?.();
      const stopHeartbeatAfterCompletion = () => {
        runCompleted = true;
        clearInterval(heartbeat);
      };

      const runSecrets = [...deps.secrets];
      let dispatchHandedOff = false;
      try {
        // Durable run ownership and its heartbeat now carry recovery. Model,
        // integration and computer setup must not occupy a queue dispatch slot.
        onRunStarted?.();
        dispatchHandedOff = Boolean(onRunStarted);
        const sourceBlocks =
          run.trigger === "messaging" && run.sourceMessageId
            ? ((
                await deps.prisma.message.findUnique({
                  where: { id: run.sourceMessageId },
                  select: { blocks: true },
                })
              )?.blocks as MessageBlock[] | undefined)
            : undefined;
        const channelId = messagingChannelId(sourceBlocks);
        const messagingChannelRun = isMessagingChannelRun(run.trigger, sourceBlocks);
        const [
          bot,
          thread,
          messages,
          peerMessage,
          task,
          storedConnections,
          main,
          settings,
          configuredMemory,
          savedSkills,
          agentSkills,
          agentSecretRows,
          initialBotCommandEnvironment,
          savedLoginPasswordRedactions,
        ] = await Promise.all([
          deps.prisma.bot.findUniqueOrThrow({
            where: { id: run.botId },
            include: { computer: true },
          }),
          deps.prisma.thread.findUniqueOrThrow({ where: { id: run.threadId } }),
          loadRunHistoryMessages(deps.prisma, run, LEGACY_HISTORY_WINDOW_SIZE, channelId),
          run.trigger === "bot_message"
            ? loadBotMessageContext(deps.prisma, run.sourceMessageId)
            : Promise.resolve(undefined),
          deps.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } }),
          deps.prisma.connection.findMany({
            where: { userId: run.userId, spaceId: run.spaceId },
            select: {
              id: true,
              connectorId: true,
              provider: true,
              providerRef: true,
              displayName: true,
              status: true,
            },
          }),
          resolveMemberMainModel(deps, run),
          deps.prisma.deploymentSettings.findUnique({
            where: { id: "default" },
          }),
          deps.memoryProviders.resolve(run.spaceId),
          deps.prisma.taughtSkill.findMany({
            where: { botId: run.botId, spaceId: run.spaceId, status: "saved" },
          }),
          listAgentSkillRecords(deps.prisma, {
            spaceId: run.spaceId,
            userId: run.userId,
          }),
          deps.prisma.agentSecret.findMany({
            where: { spaceId: run.spaceId },
            select: {
              name: true,
              secret: { select: { id: true, ciphertext: true } },
            },
          }),
          loadBotCommandEnvironment(deps.prisma, deps.secretStore, run),
          loadLoginPasswordRedactions(deps.prisma, deps.secretStore, run),
        ]);
        const historySearchBeforeSeq =
          contextStrategy !== "current" && run.sourceMessageId
            ? (messages.find((message) => message.id === run.sourceMessageId)?.seq ??
              (
                await deps.prisma.message.findUnique({
                  where: { id: run.sourceMessageId, threadId: thread.id },
                  select: { seq: true },
                })
              )?.seq ??
              thread.nextMessageSeq)
            : thread.nextMessageSeq;
        const agentEnvironment = await decryptAgentEnvironment(agentSecretRows, deps.secretStore);
        runSecrets.push(...Object.values(agentEnvironment));
        // Encoded forms too: read_file redacts with these values before any shell command runs.
        runSecrets.push(...commandCredentialRedactions(initialBotCommandEnvironment));
        // A login filled in an earlier run may still be on its page, and anything this run reads
        // or is given may contain it, so every run hides its saved passwords before the model runs.
        runSecrets.push(...savedLoginPasswordRedactions);
        const agentEnvironmentInstruction = formatAgentEnvironmentInstruction({
          ...agentEnvironment,
          ...initialBotCommandEnvironment,
        });
        // modelPinned distinguishes the captured choice from an attempt's recorded model.
        const modelChoice = runModelChoice(run, bot);
        const hasModelOverride = Boolean(modelChoice.modelProvider && modelChoice.modelId);
        const overrideCredential =
          hasModelOverride && modelChoice.modelProvider
            ? await findConnectedModelCredential(
                deps.prisma,
                deps.secretStore,
                run,
                modelChoice.modelProvider,
                modelChoice.modelId,
              )
            : null;
        runAbortController = new AbortController();
        if (!leaseValid) runAbortController.abort();
        if (deps.shutdownSignal?.aborted) runAbortController.abort(deps.shutdownSignal.reason);
        const onShutdown = () => runAbortController?.abort(deps.shutdownSignal?.reason);
        deps.shutdownSignal?.addEventListener("abort", onShutdown);
        detachShutdown = () => deps.shutdownSignal?.removeEventListener("abort", onShutdown);
        const composioRows = storedConnections.filter(
          (connection) => connection.connectorId === "composio",
        );
        let liveSlugs: string[] = [];
        if (needsLivePluginSync(composioRows)) {
          const listing = await loadLivePluginSlugs(deps.listConnectedPluginSlugs, run.userId);
          if (listing.ok) {
            liveSlugs = listing.slugs;
            await persistLivePluginConnections(deps.prisma, run, composioRows, listing.slugs).catch(
              () => undefined,
            );
          }
        }
        const connectedComposio = mergeConnectedPlugins(composioRows, liveSlugs);
        const connectedPlugins = selectRunConnections(
          storedConnections,
          connectedComposio.map((connection) => connection.provider),
        );
        const context = {
          operationId: runId,
          traceId: runId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          runId,
          screenLeaseId: screenLeaseIdForRun(computerLease, runId, fence),
          signal: runAbortController.signal,
          ...connectedContext(connectedPlugins),
          connectedProviders: connectedComposio.map((row) => row.provider),
        };
        const memoryScope = configuredMemory
          ? effectiveMemoryScope(bot.memoryScope, configuredMemory.defaultScope)
          : null;
        const semanticMemory: SemanticMemoryProvider | null = configuredMemory?.provider ?? null;

        await deps.events.append({
          spaceId: run.spaceId,
          threadId: thread.id,
          botId: bot.id,
          type: "run.started",
          runId,
          payload: { trigger: run.trigger, routineId: run.routineId },
        });

        const discoveredPromise = deps.connector
          ? deps.connector.discoverTools(context)
          : Promise.resolve([]);
        const threadContext = threadContextForRun(
          run.trigger,
          {
            messages: [...messages].reverse().map((m) => ({
              id: m.id,
              createdAt: m.createdAt?.toISOString(),
              seq: m.seq,
              role: (m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant") as
                | "user"
                | "assistant"
                | "system",
              content: isPartialReplyClientNonce(m.clientNonce)
                ? `${messageToAgentHistoryText(m)}\n\n${PARTIAL_REPLY_NOTE}`
                : messageToAgentHistoryText(m),
            })),
            summary: thread.historyCompactionSummary,
            historyCompactedUpToSeq: thread.historyCompactedUpToSeq,
          },
          messagingChannelRun,
          run.sourceMessageId,
        );
        const compactedHistory = selectCompactedHistory({
          messages: threadContext.messages,
          summary: threadContext.summary,
          historyCompactedUpToSeq: threadContext.historyCompactedUpToSeq,
        });
        let history = compactedHistory.history.map(({ id, role, content, createdAt }) => ({
          id,
          createdAt,
          role,
          content,
        }));
        const historyMessages = messages.map((message) => ({
          id: message.id,
          role: message.role,
          runId: message.runId,
          blocks: message.blocks as MessageBlock[],
        }));
        const currentTurnMessage = userTurnMessageForRun(
          run.trigger,
          runId,
          historyMessages,
          run.sourceMessageId,
        );
        const turnBlocks = currentTurnMessage?.blocks;
        const allowSilentPeerMessage = botMessageAllowsSilence(
          peerMessage?.intent,
          peerMessage?.repliesToRequest,
        );
        const allowSilentEmptyRun =
          allowSilentPeerMessage || messagingChannelRun || runAllowsSilentEmpty(run.trigger);
        const emptyResponseText = peerMessage
          ? peerMessage.intent === "result" ||
            peerMessage.intent === "status" ||
            peerMessage.intent === "question" ||
            peerMessage.repliesToRequest
            ? `Update from ${peerMessage.fromBotName}: ${peerMessage.text}`
            : DELEGATED_EMPTY_NOTICE
          : undefined;
        const recallPromise =
          threadContext.includeSemanticRecall &&
          semanticMemory &&
          memoryScope &&
          thread.historyCompactedUpToSeq != null
            ? semanticMemory.recall(
                {
                  query: task.prompt,
                  scope: memoryScope,
                  botId: bot.id,
                  historyGeneration: thread.historyCompactionGeneration,
                  limit: MAX_RECALLED_MEMORIES,
                },
                context,
              )
            : Promise.resolve(null);
        const [
          discovered,
          currentTurnImages,
          memoryContext,
          scratchpadContext,
          ticketContext,
          recalled,
        ] = await Promise.all([
          discoveredPromise,
          loadCurrentTurnImages(deps, turnBlocks, context),
          messagingChannelRun
            ? Promise.resolve("")
            : loadAgentMemoryContext(deps.memory, bot.id, context),
          messagingChannelRun
            ? Promise.resolve("")
            : loadAgentScratchpadContext(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
              }),
          messagingChannelRun || !deps.ticketBoardEnabled
            ? Promise.resolve(undefined)
            : loadAgentTicketContext(deps, {
                spaceId: run.spaceId,
                text: task.prompt,
              }),
          recallPromise,
        ]);
        const semanticMemoryEnabled = Boolean(semanticMemory) && !messagingChannelRun;
        let recalledMemory = "";
        let recallSucceeded = false;
        if (recalled) {
          if (recalled.ok && recalled.value.length > 0) {
            recallSucceeded = true;
            recalledMemory = formatRecalledMemory(recalled.value);
          } else if (!recalled.ok) {
            getLogger().error("semantic memory recall failed", recalled.error);
          }
        }
        if (!compactedHistory.usedLocalSummary) {
          history = history.slice(
            -historyWindowSize({
              semanticMemoryEnabled: semanticMemoryEnabled && !thread.historyCompactionSummary,
              compacted: thread.historyCompactedUpToSeq != null,
              recallSucceeded,
            }),
          );
        }
        const runDeployment = deps.deploymentModelConfigured ? resolveDeploymentModel() : null;
        const runtimeFallback = runtimeFallbackModel(deps.runtime);
        const pinError =
          run.modelPinned &&
          !(
            (await modelCreditBillingEnabled(deps)) &&
            modelChoice.modelProvider === runDeployment?.provider
          )
            ? pinnedModelCredentialError(modelChoice, overrideCredential)
            : undefined;
        const selected = selectConfiguredModel({
          override: modelChoice,
          overrideCredential,
          main,
          hostedProvider: (await modelCreditBillingEnabled(deps))
            ? resolveDeploymentModel().provider
            : undefined,
          defaults: { settings, deployment: runDeployment },
        });
        const { credential, thinkingLevel } = selected;
        const runModelProvider = selected.provider ?? runtimeFallback?.provider;
        const runModelId = selected.id ?? runtimeFallback?.id;
        // A missing or refused connection of the user's own fails every scheduled run alike.
        const failRunBeforeModel = async (message: string, accountFailure = false) => {
          const failed = await failRunBeforeTurn(
            deps,
            run,
            bot.name,
            { attemptId: attempt.id, workerId, fence },
            message,
          );
          if (failed && accountFailure && run.trigger === "routine" && run.routineId) {
            await backOffRoutineAfterAccountError(deps, run.routineId);
          }
        };
        if (pinError) {
          await failRunBeforeModel(pinError, pinError === PINNED_PROVIDER_NOT_CONNECTED);
          return;
        }
        if (
          run.modelPinned &&
          (selected.provider !== modelChoice.modelProvider || selected.id !== modelChoice.modelId)
        ) {
          await failRunBeforeModel(PINNED_PROVIDER_NOT_CONNECTED, true);
          return;
        }
        if (!runModelProvider || !runModelId) {
          await failRunBeforeModel(MISSING_MODEL_RUN_ERROR, true);
          return;
        }
        // An incompatible saved model is a configuration error. Record it on the run.
        // Leaving it for the setup catch would retry and replace the message.
        let resolved: Awaited<ReturnType<typeof resolveModelKey>>;
        try {
          resolved = await resolveModelKey(
            deps,
            run.userId,
            run.spaceId,
            credential,
            runModelProvider,
            runModelId,
            (values) => runSecrets.push(...values),
          );
        } catch (error) {
          // A dead or account-switched credential is already deleted. Retrying
          // setup would requeue the run and might fall back to another model.
          if (!isTerminalModelSetupError(error)) throw error;
          await failRunBeforeModel(
            error instanceof Error ? error.message : "Connect the provider again.",
            error instanceof HostedModelCreditsRequiredError ||
              isRetiredModelCredentialError(error),
          );
          return;
        }
        runSecrets.push(...resolved.redact);
        // A pin stays as it was created. Unpinned runs still record the model they
        // used; modelPinned is what keeps that record from becoming the next choice.
        if (!run.modelPinned) {
          await deps.prisma.run.updateMany({
            where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
            data: { modelProvider: runModelProvider, modelId: runModelId },
          });
        }

        if (!bot.computer) throw new Error("Bot has no computer");
        const storedComputer = bot.computer;
        const computerMode = parseComputerMode(storedComputer.scope);
        const artifacts = deps.artifacts;
        const recentFilesInput = {
          context,
          computerMode,
          skipMessageId: currentTurnMessage?.id,
          maxTurns: RECENT_TURN_IMAGE_TURNS,
        };
        const runComputer = lazyRunComputer(
          async () => {
            getLogger().info("computer.requested");
            const computer = await provisionComputer(deps, storedComputer.id, context, "bot");
            screenRelease = { computer, context, keepWarm: false };
            scheduleComputerSleep(deps.jobs, storedComputer.id);
            // Earlier attachments wait for the computer's first use; every start copies them
            // again, so they need no checkpoint, and each copy logs and skips its own failure.
            if (artifacts) {
              await materializeRecentThreadFiles({ ...deps, artifacts }, history, historyMessages, {
                ...recentFilesInput,
                computer: async () => computer,
              });
            }
            return computer;
          },
          () => runAbortController?.abort(),
        );
        const computerKind = (await deps.sandbox.provisionKind?.()) ?? storedComputer.kind;
        const workspaceCheckpoint = createRunWorkspaceCheckpoint(async () => {
          if (!runComputer.ready) return;
          await checkpointRunComputerWorkspace(deps, storedComputer, runComputer.ready, context);
        }, context.signal);
        const pendingTurnFiles: MessageBlock[][] = [turnBlocks ?? []];
        let copyingTurnFiles = Promise.resolve();
        // Serialize copies before each tool, including attachments received while a boot is in flight.
        const getRunComputer = async (reason: "tool" | "takeover" | "script", tool?: string) => {
          if (computerUseReason === "none") {
            computerUseReason = reason;
            computerUseTool = tool && BUILTIN_AGENT_TOOL_NAMES.has(tool) ? tool : undefined;
          }
          return getLogger().withContext(
            {
              reason: computerUseReason,
              tool: computerUseTool,
              trigger: run.trigger,
              "run.id": runId,
              "computer.id": storedComputer.id,
            },
            async () => {
              const computer = await runComputer.get();
              copyingTurnFiles = copyingTurnFiles
                .catch(() => undefined)
                .then(async () => {
                  while (artifacts && pendingTurnFiles.length) {
                    const files = await materializeCurrentTurnFiles(
                      { ...deps, artifacts },
                      pendingTurnFiles[0],
                      {
                        context,
                        computer: async () => computer,
                        computerMode,
                        markWorkspaceDirty: workspaceCheckpoint.markDirty,
                      },
                    );
                    workspaceCheckpoint.markFiles(files);
                    pendingTurnFiles.shift();
                  }
                });
              await copyingTurnFiles;
              return computer;
            },
          );
        };
        let currentTurnFiles: Awaited<ReturnType<typeof listCurrentTurnFiles>> = [];
        let recentThreadFiles: Awaited<ReturnType<typeof listRecentThreadFiles>> = [];
        try {
          if (artifacts) {
            currentTurnFiles = await listCurrentTurnFiles(deps, turnBlocks, context);
            recentThreadFiles = await listRecentThreadFiles(
              deps,
              history,
              historyMessages,
              recentFilesInput,
            );
          }
        } catch (error) {
          await workspaceCheckpoint.flush().catch(() => undefined);
          throw error;
        }
        const attachedFilesPrompt = [
          currentTurnFilesInstruction(currentTurnFiles),
          recentThreadFilesInstruction(recentThreadFiles),
        ]
          .filter(Boolean)
          .join("\n\n");
        const graphical =
          computerKind !== "desktop" && deps.sandbox.describe().capabilities.graphical;
        // Gate on the model this run will actually call — the pair written to the run row
        // above. Deriving it a second time here dropped the deployment fallback, so a
        // vision-capable default was gated as "scripted" and lost its screenshot tools.
        const modelSeesImages = modelAcceptsImageInput(
          runModelProvider,
          runModelId,
          resolved.acceptsImages,
        );
        const acceptsImages = deps.runtime.describe().capabilities.scripted || modelSeesImages;
        const groupContext = thread.groupId
          ? await loadGroupContext(deps.prisma, thread.groupId, {
              id: bot.id,
              name: bot.name,
            })
          : undefined;
        const hasMessagingIdentity = deps.messaging
          ? await deps.messaging.hasIdentity(bot.id)
          : false;
        const messagingContext = hasMessagingIdentity
          ? [messagingDmSurfaceNote(), messagingChannelRun ? messagingChannelPrivacyBlock() : null]
              .filter(Boolean)
              .join("\n\n")
          : undefined;
        if (heldForTakeover) {
          const held = await deps.prisma.run.findUnique({
            where: { id: runId },
            select: { status: true, checkpoint: true },
          });
          if (held) {
            ({ resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume } =
              refreshTakeoverContinuePlan(
                { resumeCheckpoint, heldForTakeover, resumeHeldLease, takeoverResume },
                held,
              ));
          }
        }
        const sourceMessage =
          (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
            ? await deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId },
                select: { clientNonce: true, role: true, blocks: true },
              })
            : null;
        // Calls carry no schema flag: the sending client encodes them in the clientNonce.
        const sourceClientNonce = sourceMessage?.clientNonce ?? null;
        // A follow-up can be queued by a bot (group handoffs); only the user's own counts.
        const ownerStartedRun = isOwnerStartedRun(run.trigger, sourceMessage?.role === "user");
        // A hang-up run has no source message: its own nonce carries the call it closes.
        const callEndRun = run.trigger === "call_end";
        const callClientNonceForRun = callEndRun ? run.clientNonce : sourceClientNonce;
        const voiceCall = callEndRun || isCallClientNonce(sourceClientNonce);
        const graphicalToolsAllowed = graphical && acceptsImages && !heldForTakeover;
        const pageBrowserAllowed =
          graphical && browser.describe().capabilities.page && !heldForTakeover;
        const disabledBuiltinTools = disabledBuiltinToolSet(bot.disabledBuiltinTools);
        const builtins = [
          ...selectBuiltinToolsForRun({
            ticketBoardEnabled: deps.ticketBoardEnabled,
            phoneCallsEnabled: deps.phoneCallsEnabled,
            historyRetrievalEnabled: contextStrategy !== "current",
            graphicalToolsAllowed,
            pageBrowserAllowed,
            groupId: thread.groupId,
            trigger: run.trigger,
            semanticMemoryEnabled,
            semanticMemoryForgets: Boolean(semanticMemory?.forget),
            mediaImagesEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.images),
            mediaVideoEnabled: Boolean(deps.artifacts && mediaGeneration?.capabilities.video),
            cloudAgentEnabled: cloudAgentsEnabled(cloudAgent, run.spaceId),
            messagingChannelRun,
            voiceCall,
            disabledBuiltinTools: bot.disabledBuiltinTools,
            fleetManagement: bot.fleetManagement,
            followUpFromUser: sourceMessage?.role === "user",
          }),
          // Cross-owner agent connections only exist for chat-linked bots.
          ...(hasMessagingIdentity &&
          bot.crossSpaceCommunication === true &&
          !isBackgroundRunTrigger(run.trigger) &&
          run.trigger !== "created"
            ? agentConnectionTools.filter((tool) => !disabledBuiltinTools.has(tool.name))
            : []),
        ];
        const exposedConnectorTools = discovered.filter(
          (tool) => !builtinAgentTools.some((builtin) => builtin.name === tool.name),
        );
        const connectorTools = new Map(
          exposedConnectorTools.map((tool) => [tool.name, tool] as const),
        );
        const {
          loadApprovalRules,
          loadApprovalModel,
          loadAutoReviewPreference,
          loadOwnerWords,
          loadTrustedSites,
          routineNamesNewSite,
          loadTrustedConnectors,
          receivedOutsideMessage,
        } = createRunTrustLoaders(deps, {
          run,
          runId,
          botId: bot.id,
          taskPrompt: task.prompt,
          ownerStartedRun,
          messagingChannelRun,
          sourceMessage,
          connectedPlugins,
        });
        // Outbound destinations this run may reach without asking. See outboundSiteGate and
        // connectorReadRequiresApproval; approvals from earlier attempts are read back from effects.
        const searchResultUrls = new Set<string>();
        // Whether outside content has entered the run. A run someone else started begins tainted,
        // and so does a later attempt, including one with restored untrusted tool results.
        let turnCheckpoint: string | undefined;
        let checkpointLoadError: Error | undefined;
        try {
          turnCheckpoint = await loadRunTurnCheckpoint(deps.prisma, run);
        } catch (error) {
          checkpointLoadError =
            error instanceof Error ? error : new Error("Unsupported turn checkpoint");
        }
        let storedTurnCheckpoint = Boolean(turnCheckpoint);
        let runTainted =
          !ownerStartedRun || Boolean(turnCheckpoint) || Boolean(checkpointLoadError);
        let earlierAttemptPromise: Promise<boolean> | undefined;
        const isRunTainted = async () => {
          if (runTainted) return true;
          earlierAttemptPromise ??= deps.prisma.attempt
            .count({ where: { runId } })
            .then((count) => count > 1);
          if ((await earlierAttemptPromise) || (await receivedOutsideMessage())) runTainted = true;
          return runTainted;
        };
        // The creation intro only asks what the bot is for (see selectBuiltinToolsForRun),
        // so it gets no connector tools either.
        const tools =
          run.trigger === "created" ? builtins : [...builtins, ...exposedConnectorTools];
        const taskCatalogInstruction = tools.some((tool) => tool.name === "task_catalog")
          ? TASK_CATALOG_GUIDANCE
          : undefined;
        const approvedEffects = await deps.prisma.externalEffect.findMany({
          where: { runId, status: "approved" },
          orderBy: APPROVED_EFFECT_REPLAY_ORDER,
          select: { kind: true, request: true, idempotencyKey: true },
        });
        const approvedEffectReplays = createApprovedEffectReplayQueue(approvedEffects);
        const baseComputerInstruction = persistentComputerInstruction({
          heldForTakeover,
          graphicalToolsAllowed,
          graphical,
          disabled: disabledBuiltinTools,
        });
        const dockerToolInstruction = dockerComputerToolInstruction(
          computerKind,
          disabledBuiltinTools,
        );
        const hostEnvironment =
          computerKind === "desktop"
            ? await deps.sandbox
                .environment?.(
                  {
                    id: storedComputer.providerRef ?? storedComputer.id,
                    botId: storedComputer.homeKey,
                    kind: "desktop",
                    providerRef: storedComputer.providerRef ?? "",
                  },
                  {
                    ...context,
                    signal: AbortSignal.any([context.signal, AbortSignal.timeout(2000)]),
                  },
                )
                .catch(() => undefined)
            : undefined;
        const hostInstruction = hostEnvironment
          ? `Commands run on the user's ${hostEnvironment.platform} computer with their account permissions. Home: ${JSON.stringify(hostEnvironment.home)}. Shell: ${JSON.stringify(hostEnvironment.shell)}. The shell tool executes commands with that shell. Use its native syntax, paths and installed tools; do not assume Linux or bash. Local files outside the bot workspace can be accessed through commands. App launching is available through OS commands; graphical screen control is unavailable.`
          : undefined;
        const computerInstruction = [
          "Use the computer only when the task needs files, commands, a browser, or an installed application. Answer directly from the conversation when sufficient; use connected tools for app data. A website with no connected app is still yours to use in the computer's browser, now and in scheduled routines, so a missing connection alone is never a reason to decline. Do not inspect the computer just to prepare for an unrelated task. If what you are about to buy, send or submit differs from what the user confirmed, such as a changed item or total, show the difference and confirm again first.",
          hostInstruction
            ? `${baseComputerInstruction} ${hostInstruction}`
            : dockerToolInstruction
              ? `${baseComputerInstruction} ${dockerToolInstruction}`
              : baseComputerInstruction,
        ].join(" ");
        const workspaceInstruction =
          computerMode === "team"
            ? `Your Team Computer home is ${teamBotWorkspaceDirectory(bot.id)}. Relative file paths and shell working directories start there. Put intentionally shared work under shared/. Other bots' folders are visible under bots/; treat them as their working areas.`
            : "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.";

        let assembled = "";
        let currentTextSegment = "";
        let messageSegments: MessageBlock[] = [];
        // Terminal subagent rows are published as their own messages (not appended to
        // messageSegments). Treat that like tool/step durable activity so we do not invent
        // an empty-run "done." completion afterward.
        let publishedTerminalSubagent = false;
        // Durable chat messages posted mid-turn (message_user / promoted narration).
        // Rehydrate from this run's prior progress rows so a resume after ask/takeover
        // still knows progress was already published (skip hollow finals; status outcome).
        let publishedMidTurnUserMessage = false;
        // Some runs hold back pre-tool narration instead of posting it as chat.
        // Keep the last segment in case the model supplies no final reply.
        let discardedMidTurnNarration = false;
        let lastDiscardedMidTurnNarration = "";
        let explicitNoResponse = false;
        let assistantTurnText = "";
        const recordExplicitNoResponse = (text: string) => {
          explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
        };
        const midTurnUserTexts: string[] = [];
        let midTurnProgressCount = 0;
        const turnStartedAtMs = run.startedAt?.getTime() ?? Date.now();
        // Durable interim messages only on genuinely long turns, capped per run.
        const canPublishDurableProgress = () =>
          midTurnProgressBudgetAllows(midTurnProgressCount, Date.now() - turnStartedAtMs);
        const canPublishDurableNarration = () =>
          runPromotesMidTurnNarration(run.trigger) && canPublishDurableProgress();
        {
          const priorProgress = await deps.prisma.message.findMany({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "asc" },
            select: { blocks: true, clientNonce: true },
          });
          for (const message of priorProgress) {
            if (!isUserProgressClientNonce(message.clientNonce)) continue;
            const blocks = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
            const text = blocks
              .filter(
                (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
              )
              .map((block) => block.text)
              .join("")
              .trim();
            if (!text) continue;
            midTurnUserTexts.push(text);
            publishedMidTurnUserMessage = true;
            midTurnProgressCount += 1;
          }
        }
        // Tool calls that land mid-sentence wait here until the narration catches up to a
        // sentence boundary, so the step chips never render in the middle of a clause.
        let pendingToolNames: string[] = [];
        const flushPendingTools = () => {
          if (currentTextSegment) {
            messageSegments = appendTextSegment(messageSegments, currentTextSegment);
            currentTextSegment = "";
          }
          for (const name of pendingToolNames) {
            messageSegments = appendToolCallSegment(messageSegments, name);
          }
          pendingToolNames = [];
        };
        const tryFlushPendingTools = () => {
          if (pendingToolNames.length > 0 && endsSentence(currentTextSegment)) flushPendingTools();
        };
        let pendingProgress = "";
        let lastProgressAt = 0;
        let hasStreamedText = false;
        // Set by a tool call or a new assistant message: the next text starts a new
        // assistant turn and needs a break from the earlier text that stayed in this reply.
        let assistantTurnBreakPending = false;
        let toolCallStreak: ToolCallStreak = { key: undefined, count: 0 };
        let lastComputerFrameId: string | undefined;
        let unchangedVisualStreak: UnchangedVisualStreak = { count: 0 };
        let terminalCheckpointComplete = false;
        let approvalPausePending = false;
        let approvalRequest: Promise<ApprovalPausedToolResult> | undefined;
        const pendingTurnCheckpoints = new Map<string, () => string>();
        const persistTurnCheckpoint = async (executionId?: string) => {
          const capture = executionId ? pendingTurnCheckpoints.get(executionId) : undefined;
          if (capture) {
            const saved = JSON.parse(capture());
            saved.effectOccurrences = effectOccurrences;
            await saveRunTurnCheckpoint(deps.prisma, run, workerId, fence, JSON.stringify(saved));
            storedTurnCheckpoint = true;
          } else if (storedTurnCheckpoint) {
            // Helper calls have no saved turn. An earlier pause's turn must not resume this one.
            await dropRunTurnCheckpoint(deps.prisma, run, workerId, fence);
            storedTurnCheckpoint = false;
          }
        };
        let handedOff = false;
        let progressRedactor = createStreamingRedactor(runSecrets);
        const scripted = deps.runtime.describe().capabilities.scripted;
        const script = scripted ? inferScript(task.prompt, takeoverResume?.checkpoint) : undefined;
        const flushProgress = async () => {
          // Routines may finish silently. Do not leak narration or a partial silence
          // sentinel before the final outcome is known.
          if (
            scripted ||
            !pendingProgress ||
            run.trigger === "routine" ||
            isBackgroundRunTrigger(run.trigger)
          )
            return;
          await deps.events.append({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            type: "thread.progress",
            runId,
            // The first flush replaces the "working…" placeholder outright — a delta here
            // would otherwise get appended straight onto it with no separator.
            payload: hasStreamedText
              ? { delta: pendingProgress, streaming: true }
              : { text: pendingProgress, streaming: true },
          });
          hasStreamedText = true;
          pendingProgress = "";
          lastProgressAt = Date.now();
        };
        const publishMidTurnNarration = async (beforeConnectCard = false) => {
          const extracted = extractNarrationText(messageSegments, currentTextSegment);
          const narration = clampUserProgressMessage(redactSecrets(extracted.text, runSecrets));
          const canPublish =
            canPublishDurableNarration() ||
            (beforeConnectCard && runPromotesMidTurnNarration(run.trigger));
          if (
            narration &&
            !canPublish &&
            !allowSilentEmptyRun &&
            runPromotesMidTurnNarration(run.trigger)
          ) {
            return;
          }
          messageSegments = extracted.remaining;
          currentTextSegment = "";
          if (!narration) return;
          hasStreamedText = false;
          pendingProgress = "";
          if (!canPublish) {
            assembled = "";
            discardedMidTurnNarration = true;
            lastDiscardedMidTurnNarration = narration;
            return;
          }
          assembled = "";
          await publishMessage(
            deps,
            run,
            "bot",
            [{ kind: "text", text: narration }],
            undefined,
            userProgressClientNonce(run.id, midTurnProgressCount++),
          );
          midTurnUserTexts.push(narration);
          publishedMidTurnUserMessage = true;
        };
        const formatObservation = (
          observation: Awaited<ReturnType<SandboxProvider["observe"]>>,
          note?: string,
          visualActionKey?: string,
        ) => {
          const guard = advanceUnchangedVisualGuard(
            unchangedVisualStreak,
            observation.frameId,
            visualActionKey,
          );
          unchangedVisualStreak = guard.streak;
          // A browser window's title is the page title, which can echo a signed-in username.
          const activeWindow = observation.activeWindow;
          const result = observationToolResult(
            activeWindow?.title
              ? {
                  ...observation,
                  activeWindow: {
                    ...activeWindow,
                    title: redactSecrets(activeWindow.title, runSecrets),
                  },
                }
              : observation,
            note,
            lastComputerFrameId,
            visualActionKey ? { unchangedVisualCount: guard.streak.count } : undefined,
          );
          lastComputerFrameId = observation.frameId;
          return result;
        };

        const pauseForApproval = () => {
          approvalPausePending = true;
          return approvalPausedToolResult();
        };

        const pauseForSecret = () => {
          approvalPausePending = true;
          return secretPausedToolResult();
        };

        const mutatingEffectOccurrences = new Map<string, number>();
        const effectOccurrences: Array<{
          executionId: string;
          fingerprint: string;
          occurrence: number;
        }> = [];
        let restoredPendingEffect: (typeof effectOccurrences)[number] | undefined;
        const consumedEffectIds = new Set<string>();
        const nextMutatingEffectOccurrence = (
          toolName: string,
          args: Record<string, unknown>,
          executionId: string,
          approvedKey?: string,
        ) => {
          const fingerprint = toolEffectIdempotencyKey(runId, toolName, args);
          const approved = approvedKey
            ? approvedEffectOccurrence(approvedKey, fingerprint)
            : undefined;
          const previous = restoredPendingEffect;
          if (previous?.executionId === executionId) {
            restoredPendingEffect = undefined;
            if (previous.fingerprint === fingerprint && approved === undefined)
              return previous.occurrence;
          }
          // An approved replay reuses the approved row's occurrence, so it claims that row
          // even when this call would have counted differently.
          const occurrence = approved ?? mutatingEffectOccurrences.get(fingerprint) ?? 0;
          effectOccurrences.push({ executionId, fingerprint, occurrence });
          mutatingEffectOccurrences.set(
            fingerprint,
            Math.max(mutatingEffectOccurrences.get(fingerprint) ?? 0, occurrence + 1),
          );
          return occurrence;
        };

        /** Fleet tools take every scope from the run, never from arguments. */
        const fleetRun: FleetRun = {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? null,
          threadId: thread.id,
          runId,
        };

        const dispatchTool = async (
          name: string,
          args: Record<string, unknown>,
          executionId: string,
          _route?: unknown,
          observer?: AgentToolExecutionObserver,
        ) => {
          context.signal.throwIfAborted();
          if (handedOff) {
            return {
              error: "This stage was handed off. End the turn without more tool calls.",
            };
          }
          if (name === "propose_instructions_update" && approvalPausePending)
            return pauseForApproval();
          if (disabledBuiltinTools.has(name)) {
            return { error: "This tool is disabled for this bot." };
          }
          if (PAGE_BROWSER_TOOL_NAMES.has(name) && !pageBrowserAllowed) {
            return { error: "Page browser is unavailable on this computer." };
          }
          if (IMAGE_RETURNING_COMPUTER_TOOLS.has(name) && !acceptsImages) {
            return { error: MODEL_CANNOT_SEE_MESSAGE };
          }
          const registerRunSecrets = (values: string[]) => {
            const additions = values.filter((value) => !runSecrets.includes(value));
            if (additions.length === 0) return;
            pendingProgress += progressRedactor.finish();
            runSecrets.push(...additions);
            progressRedactor = createStreamingRedactor(runSecrets);
          };
          let connectorCall: ConnectorCall = {
            tool: name,
            args,
            executionId,
            route: connectorTools.get(name)?.route,
          };
          const onCatalogExecuteRoute = Boolean(
            connectorCall.route &&
              !connectorCall.route.resourceId &&
              connectorCall.route.toolName === CATALOG_EXECUTE,
          );
          const approvedReplay = approvedCatalogReplay(
            approvedEffectReplays,
            name,
            CATALOG_APPROVAL_TOOL,
            onCatalogExecuteRoute,
          );
          if (approvedReplay.error) return { error: approvedReplay.error };
          if (approvedReplay.args) connectorCall.args = approvedReplay.args;
          let catalogRemapped = false;
          let resolvedTool: ConnectorTool | undefined;
          if (name.startsWith("cloud_agent_") && !validCloudAgentArgs(name, args)) {
            return {
              error: "Invalid cloud agent arguments. Raw environment variables are not supported.",
            };
          }
          let effectRequest: unknown = args;
          if (connectorCall.route && deps.connector?.resolveCall) {
            try {
              const resolved = await deps.connector.resolveCall(connectorCall, context);
              if (resolved) {
                if (BUILTIN_AGENT_TOOL_NAMES.has(resolved.tool.name)) {
                  return {
                    error: "Connector tool name conflicts with a built-in tool",
                  };
                }
                name = resolved.tool.name;
                args = resolved.call.args;
                catalogRemapped = true;
                resolvedTool = resolved.tool;
                effectRequest = catalogApprovalRequest(
                  connectorCall.tool,
                  connectorCall.args,
                  CATALOG_APPROVAL_TOOL,
                  resolved.tool.route?.resourceId &&
                    resolved.tool.route.connectorId &&
                    resolved.tool.route.toolName
                    ? {
                        connectorId: resolved.tool.route.connectorId,
                        resourceId: resolved.tool.route.resourceId,
                        resourceRevision: resolved.tool.route.resourceRevision,
                        toolName: resolved.tool.route.toolName,
                      }
                    : undefined,
                );
                connectorCall = resolved.call;
              }
            } catch (error) {
              return { error: sanitizeConnectorError(error) };
            }
          }
          if (approvedReplay.args && !catalogRemapped) {
            return {
              error:
                "Approved catalog request could not be resolved to a tool. Deny and retry the direct tool call.",
            };
          }
          if (
            !catalogRemapped &&
            connectorCall.route?.resourceId &&
            connectorCall.route.connectorId &&
            connectorCall.route.toolName
          ) {
            effectRequest = boundDirectApprovalRequest(
              {
                connectorId: connectorCall.route.connectorId,
                resourceId: connectorCall.route.resourceId,
                resourceRevision: connectorCall.route.resourceRevision,
                toolName: connectorCall.route.toolName,
              },
              args,
              CATALOG_APPROVAL_TOOL,
            );
          }
          // Approval applies to the exact persisted request, never to a payload the model
          // reconstructs after the worker resumes. This also makes a changed reconstruction
          // hit the already-approved effect instead of creating a second approval card.
          const nextApprovedTool = approvedEffectReplays.nextToolName();
          let approvedEffectKey: string | undefined;
          const nextApprovedRequest = approvedEffectReplays.nextRequest();
          const liveRoute =
            connectorCall.route?.resourceId &&
            connectorCall.route.connectorId &&
            connectorCall.route.toolName
              ? {
                  connectorId: connectorCall.route.connectorId,
                  resourceId: connectorCall.route.resourceId,
                  resourceRevision: connectorCall.route.resourceRevision,
                  toolName: connectorCall.route.toolName,
                }
              : undefined;
          const nextBound = boundDirectApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
          const nextCatalog = catalogApprovalDetails(nextApprovedRequest, CATALOG_APPROVAL_TOOL);
          // After collision uniquify, the live tool name may differ from the stored effect
          // kind while still targeting the same bound connector resource.
          const sameBoundResource = Boolean(
            nextBound && liveRoute && approvalRoutesMatch(nextBound.route, liveRoute),
          );
          // After catalog shrink, a catalog approval may resume as the matching direct tool.
          const sameCatalogTarget = Boolean(
            nextCatalog && catalogApprovalMatchesLiveRoute(nextCatalog, liveRoute),
          );
          if (
            nextApprovedTool &&
            nextApprovedTool !== name &&
            !sameBoundResource &&
            !sameCatalogTarget
          ) {
            return {
              error: `Approved request ${nextApprovedTool} must be replayed before ${name}.`,
            };
          }
          // Drain FIFO only when the pending approval matches this path (catalog vs direct).
          const replayEffectToolName = approvalReplayEffectToolName(
            name,
            nextApprovedTool,
            sameBoundResource || sameCatalogTarget,
          );
          if (
            nextApprovedTool &&
            (nextApprovedTool === name || sameBoundResource || sameCatalogTarget)
          ) {
            const pathError = approvalReplayPathError(
              name,
              catalogRemapped,
              nextApprovedRequest,
              CATALOG_APPROVAL_TOOL,
              liveRoute,
            );
            if (pathError) return { error: pathError };
            const resourceError = approvalReplayResourceError(
              name,
              catalogRemapped,
              nextApprovedRequest,
              liveRoute,
              CATALOG_APPROVAL_TOOL,
            );
            if (resourceError) return { error: resourceError };
            approvedEffectKey = approvedEffectReplays.nextIdempotencyKey();
            const approvedRequest = approvedEffectReplays.take(nextApprovedTool)!;
            const approvedCatalog = catalogApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL);
            if (approvedCatalog && !catalogRemapped) {
              // Shrink-to-direct: restore approved inner arguments, not the wrapper envelope.
              const innerArgs = catalogApprovalInnerArgs(approvedCatalog);
              if (!innerArgs) {
                return {
                  error: `Approved catalog request ${name} is missing tool arguments.`,
                };
              }
              args = innerArgs;
            } else {
              // Catalog wrappers keep resolveCall's parsed args so Zod stripping/coercion
              // still matches the first-approval effect key and execute payload.
              args = approvedReplayArgs(approvedRequest, args, CATALOG_APPROVAL_TOOL);
            }
            // Bound / shrink-direct approvals may skip catalog parse — reject before execute
            // if they no longer match the live schema.
            if (
              boundDirectApprovalDetails(approvedRequest, CATALOG_APPROVAL_TOOL) ||
              (approvedCatalog && !catalogRemapped)
            ) {
              const liveSchema = (resolvedTool ?? connectorTools.get(name))?.inputSchema;
              if (liveSchema) {
                try {
                  assertConnectorToolArgs(liveSchema, args);
                } catch (error) {
                  return { error: sanitizeConnectorError(error) };
                }
              }
            }
          }
          const fleetWrite =
            FLEET_WRITE_TOOL_NAMES_SET.has(name) ||
            name === "archive_bot" ||
            (name === "update_bot" && argumentGiven(args.bot_id));
          if (fleetWrite || name === "list_fleet") {
            if (isSubagentToolExecution(executionId))
              return { error: "Helpers cannot use bot management tools." };
            // The run-start snapshot is not enough: the owner can turn the switch off mid-run.
            const live = await deps.prisma.bot.findUnique({
              where: { id: bot.id },
              select: { fleetManagement: true },
            });
            if (!live?.fleetManagement) return { error: "This tool is disabled for this bot." };
            if (!ownerStartedRun) return { error: "Bot management tools need a run you started." };
            if (fleetWrite && (await receivedOutsideMessage()))
              return {
                error:
                  "Changes to the bots you manage are blocked for the rest of this run because it received a channel or webhook message.",
              };
          }
          if (name === "propose_instructions_update") {
            try {
              if (run.trigger === "follow_up" && !ownerStartedRun)
                return {
                  error: "Instruction updates are blocked for externally triggered runs.",
                };
              if (!nextApprovedTool) validateInstructionProposal(args, run.trigger);
              else
                validateInstructionProposal(
                  { instructions: args.instructions, reason: args.reason },
                  run.trigger,
                );
              if (
                redactSecrets(String(args.instructions), runSecrets) !== args.instructions ||
                redactSecrets(String(args.reason), runSecrets) !== args.reason
              )
                return { error: "Instruction proposals cannot contain credentials." };
              const instructionProposalBot = await reserveInstructionProposal(
                deps.prisma,
                bot.id,
                runId,
              );
              if (!nextApprovedTool) {
                args = { ...args, previousInstructions: instructionProposalBot.instructions };
              }
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : "Invalid instruction proposal.",
              };
            }
          }
          let fleetSummary: FleetCardSummary | undefined;
          if (isFleetApprovalTool(name) && nextApprovedTool !== name) {
            // Resolve names, members, model and schedule now; an approved replay runs the stored
            // request above and never resolves them again.
            const prepared = await prepareFleetRequest(
              fleetPrepareDeps(deps, run),
              fleetRun,
              name,
              args,
              runSecrets,
            );
            if (!prepared.ok) return { error: prepared.error };
            args = prepared.canonical;
            fleetSummary = prepared.summary;
          }
          if (name === "respond_agent_connection") {
            if (nextApprovedTool !== name) {
              const request = await prepareAgentConnectionResponse(
                deps.prisma,
                bot.id,
                Boolean(args.accept),
              );
              if (!request) return { error: "no pending connection request" };
              args = request;
            } else if (
              typeof args.requester_name !== "string" ||
              typeof args.requester_address !== "string" ||
              typeof args.requester_provider !== "string"
            ) {
              return { error: "connection request is no longer pending" };
            }
          }
          if (
            name === "propose_instructions_update" ||
            name === "respond_agent_connection" ||
            isFleetApprovalTool(name)
          )
            effectRequest = args;
          const viaConnector = !BUILTIN_AGENT_TOOL_NAMES.has(name);
          // Declared effect of the operation this call dispatches (installed API method and
          // flag). Install config is immutable per route resource, so it cannot drift before
          // execute; a catalog call uses the tool it was just resolved to.
          const declaredReadOnly = viaConnector
            ? (resolvedTool ?? connectorTools.get(name))?.readOnly
            : undefined;
          // A Composio batch names its actions in tools[].tool_slug, so rules and the read/write
          // check look at each action, never the batch tool. An entry naming no action asks.
          const composioBatch = composioBatchActions(name, args);
          const unidentifiedAction = Boolean(composioBatch && !composioBatch.complete);
          const approvalToolNames = composioBatch?.slugs.length ? composioBatch.slugs : [name];
          const declaredReadOnlyFor = (toolName: string) =>
            toolName === name ? declaredReadOnly : connectorTools.get(toolName)?.readOnly;
          const requiresUnattendedApproval =
            (unidentifiedAction && run.trigger === "webhook") ||
            approvalToolNames.some((toolName) =>
              unattendedTriggerToolRequiresApproval(
                run.trigger,
                toolName,
                viaConnector,
                declaredReadOnlyFor(toolName),
              ),
            );
          const connectorProviders = connectedPlugins.map((plugin) => plugin.provider);
          const connectorKind = connectorKindFromToolName(name, connectorProviders);
          const fetchUrl =
            name === "web_fetch" ? normalizedHttpUrl(String(args.url ?? "")) : undefined;
          const fetchSite = fetchUrl ? urlSite(fetchUrl) : undefined;
          if (name === "web_fetch" && !fetchSite) return { error: "url must be an http(s) URL" };
          if (fetchUrl && fetchUrl.length > MAX_FETCH_URL_LENGTH)
            return { error: `url must be at most ${MAX_FETCH_URL_LENGTH} characters` };
          // The card, the stored effect and the request all use the URL the gate checked.
          if (fetchUrl) {
            args = { ...args, url: fetchUrl };
            effectRequest = args;
          }
          const connectorTrusts = connectorTrustKeys(
            name,
            args,
            connectorCall.route,
            connectorKind,
            connectorProviders,
          );
          const siteGate =
            fetchUrl && fetchSite
              ? outboundSiteGate({
                  site: fetchSite,
                  trusted:
                    searchResultUrls.has(fetchUrl) || (await loadTrustedSites()).has(fetchSite),
                  rules: await loadApprovalRules(),
                })
              : "allow";
          const connectorReadGated =
            viaConnector &&
            !unidentifiedAction &&
            approvalToolNames.every(
              (toolName) => !connectorToolRequiresApproval(toolName, declaredReadOnlyFor(toolName)),
            ) &&
            connectorReadRequiresApproval({
              tainted: await isRunTainted(),
              connectorTrusted: await loadTrustedConnectors().then((trusted) =>
                connectorTrusts.every((trust) => trusted.has(trust)),
              ),
            });
          // This schedules unattended shell execution; require a person to approve
          // the command once, rather than letting an allow rule or reviewer schedule it.
          const commandWatch =
            name === "schedule_create" && commandWatchFromTool(args.watch) !== undefined;
          // A routine's prompt counts as the owner's words when it runs, so the sites it names are
          // ones its runs may fetch. Once outside content entered this run, a routine naming a
          // site this run was not given needs a person: a reviewer would judge it on this run's
          // context, and passing it would trust the site for every later run.
          const scheduleNamesNewSite =
            (name === "schedule_create" || (name === "schedule_update" && Boolean(args.prompt))) &&
            (await isRunTainted()) &&
            (await routineNamesNewSite(String(args.prompt ?? "")));
          const requiresApprovalByDefault =
            commandWatch ||
            requiresUnattendedApproval ||
            siteGate === "new" ||
            unidentifiedAction ||
            approvalToolNames.some((toolName) =>
              toolRequiresApproval(toolName, viaConnector, declaredReadOnlyFor(toolName)),
            );
          // A gated read still fails closed when its review errors, and keeps its approval key.
          const gated = requiresApprovalByDefault || connectorReadGated;
          const requiresMandatoryApproval =
            commandWatch ||
            scheduleNamesNewSite ||
            requiresUnattendedApproval ||
            toolRequiresExplicitApproval(name);
          const resolvedRules = resolveActionApprovalForTools({
            tools: approvalToolNames.map((toolName) => ({
              name: toolName,
              connectorKind:
                toolName === name
                  ? connectorKind
                  : connectorKindFromToolName(toolName, connectorProviders),
              readOnly: declaredReadOnlyFor(toolName),
            })),
            wrapper: composioBatch ? { name, connectorKind } : undefined,
            site: fetchSite,
            rules: await loadApprovalRules(),
          });
          const approvalResolved =
            unidentifiedAction && resolvedRules.decision === "allow"
              ? { ...resolvedRules, decision: "ask" as const }
              : resolvedRules;
          const mode = approvalModeFromPreference(await loadAutoReviewPreference());
          const reviewable = mode === "auto" && !requiresMandatoryApproval;
          const injectedReview = reviewable ? deps.autoReview : undefined;
          const reviewSettings = !reviewable || injectedReview ? null : await loadApprovalModel();
          const memberChecker = reviewSettings?.primarySource === "member";
          const checker = !reviewable
            ? undefined
            : reviewSettings
              ? reviewSettings.primary
                ? {
                    provider: reviewSettings.primary.provider,
                    model: reviewSettings.primary.modelId,
                    thinkingLevel: reviewSettings.primary.thinkingLevel,
                    credentialId: reviewSettings.primary.credentialId,
                  }
                : null
              : resolveAutoReviewChecker();
          const checkerConfigured =
            reviewable &&
            (Boolean(injectedReview) ||
              memberChecker ||
              Boolean(reviewSettings?.backups.length) ||
              (checker
                ? isAutoReviewCheckerConfigured({}) ||
                  Boolean(
                    await findConnectedModelCredential(
                      deps.prisma,
                      deps.secretStore,
                      { userId: run.userId, spaceId: run.spaceId },
                      checker.provider,
                    ),
                  )
                : false));
          const plan = planActionGate({
            resolved: approvalResolved,
            mode,
            mandatory: requiresMandatoryApproval,
            steerable:
              requiresMandatoryApproval && mode === "never"
                ? !ownerStartedRun || (await isRunTainted())
                : undefined,
            consequential: requiresApprovalByDefault,
            reviewOnly: connectorReadGated,
            checkerConfigured,
            newDestination: siteGate === "new",
          });
          if (plan === "deny") {
            return {
              error:
                approvalResolved.decision === "deny"
                  ? `${name} is blocked in this space. Don't try it another way; tell the user it's blocked.`
                  : `${name} needs the owner's approval because it could have been asked for by someone else, and this space never asks. Don't retry; tell the user.`,
            };
          }
          let reviewReason: string | undefined;
          let gateDecision: "ask" | "allow" = plan === "ask" ? "ask" : "allow";
          const needsApprovalEarly = plan === "ask" || plan === "judge";
          // A resumed approval keeps its key even if "Always allow" changed the policy.
          const usesApprovalKey =
            nextApprovedTool || name === "request_secret" || needsApprovalEarly || gated;
          // Count before choosing a key so an approved replay (occurrence 0 / base
          // key) cannot collide with a later identical-args call in this attempt.
          // request_secret stays single-use: retries must reuse the same card.
          const occurrence =
            name === "request_secret" || name === "connect_app"
              ? 0
              : nextMutatingEffectOccurrence(
                  replayEffectToolName,
                  args,
                  executionId,
                  approvedEffectKey,
                );
          // An approved replay claims the row the user approved. A derived key can differ
          // (another call's occurrence count), which would ask again and strand the approval.
          const effectKey =
            approvedEffectKey ??
            (usesApprovalKey && occurrence === 0
              ? approvalEffectKey(runId, replayEffectToolName, args)
              : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence));
          // Connector read-only hints must not bypass approval, review, or replay decisions.
          // A fetch to a new site is gated like any action, so it needs an effect to approve.
          const applied =
            READ_ONLY_AGENT_TOOLS.has(name) &&
            siteGate !== "new" &&
            nextApprovedTool !== name &&
            !approvedEffectKey
              ? undefined
              : await recordEffect(
                  deps,
                  run,
                  replayEffectToolName,
                  effectKey,
                  effectRequest,
                  executionId,
                  consumedEffectIds,
                );

          const runAutoReview = async () => {
            if (!injectedReview && !checker && !reviewSettings?.backups.length) return;
            try {
              const botDescription = redactSecrets(
                `${bot.name}: ${bot.title}\n${bot.description}`,
                runSecrets,
              );
              // A new site is judged on the full URL and the owner's own words only: the task
              // prompt of a webhook or bot-started run carries text someone else wrote.
              const reviewRequest: AutoReviewRequest =
                siteGate === "new" && fetchUrl
                  ? {
                      toolName: name,
                      connectorKind,
                      args: { url: redactSecrets(fetchUrl, runSecrets) },
                      userTask: redactSecrets(await loadOwnerWords(), runSecrets),
                      botDescription,
                      matchingRules: approvalResolved.matchingRules,
                      newSite: true,
                    }
                  : {
                      toolName: name,
                      connectorKind,
                      args: redactToolArgsForReview(args, runSecrets),
                      userTask: redactSecrets(task.prompt, runSecrets),
                      botDescription,
                      matchingRules: approvalResolved.matchingRules,
                    };
              const reviewContext: AdapterContext = {
                operationId: `auto-review:${runId}`,
                traceId: `auto-review:${runId}`,
                spaceId: run.spaceId,
                userId: run.userId,
                botId: bot.id,
                runId,
                signal: context.signal,
              };
              const checkerProvider = (checker: AutoReviewChecker) =>
                autoReviewCheckerProvider(
                  deps,
                  {
                    runId,
                    spaceId: run.spaceId,
                    userId: run.userId,
                    botId: bot.id,
                    threadId: thread.id,
                  },
                  {
                    injectedReview,
                    memberChecker,
                    backups: reviewSettings?.backups,
                    registerSecrets: (values) => runSecrets.push(...values),
                  },
                  checker,
                );
              const judge = await reviewWithBackups(
                [
                  ...(checker
                    ? [checker]
                    : injectedReview
                      ? [{ provider: "injected", model: "injected" }]
                      : []),
                  ...(reviewSettings?.backups.map((choice) => ({
                    provider: choice.provider,
                    model: choice.modelId,
                    thinkingLevel: choice.thinkingLevel,
                    credentialId: choice.credentialId,
                  })) ?? []),
                ],
                async (checker) => {
                  const provider = await checkerProvider(checker);
                  return provider.review(reviewRequest, reviewContext);
                },
                context.signal,
              );
              if (context.signal.aborted) return;
              reviewReason = judge.reason;
              gateDecision = applyJudgeDecision({
                decision: judge.decision,
                consequential: gated,
              });
              if (applied) {
                await deps.prisma.externalEffect.update({
                  where: { id: applied.effect.id },
                  data: {
                    reviewDecision: judge.decision,
                    reviewReason: judge.reason,
                    reviewModel: judge.model,
                  },
                });
              }
            } catch {
              // Cancellation must not write a review the next attempt would reuse.
              if (context.signal.aborted) return;
              // Auth/refresh failures must fail closed like a checker error, not fail the run.
              reviewReason = "Checker could not authenticate.";
              gateDecision = applyJudgeDecision({
                decision: "error",
                consequential: gated,
              });
              if (applied) {
                await deps.prisma.externalEffect.update({
                  where: { id: applied.effect.id },
                  data: {
                    reviewDecision: "error",
                    reviewReason,
                    reviewModel: checker
                      ? `${checker.provider}/${checker.model}`
                      : (injectedReview?.describe().id ?? "auto-review"),
                  },
                });
              }
            }
          };

          if (applied && plan === "judge" && (injectedReview || checker)) {
            if (!applied.duplicate) {
              await runAutoReview();
            } else {
              const priorDecision = applied.effect.reviewDecision;
              if (priorDecision === "ask" || priorDecision === "error") {
                reviewReason =
                  typeof applied.effect.reviewReason === "string"
                    ? applied.effect.reviewReason
                    : undefined;
                gateDecision = "ask";
              } else if (priorDecision === "pass") {
                reviewReason =
                  typeof applied.effect.reviewReason === "string"
                    ? applied.effect.reviewReason
                    : undefined;
                gateDecision = "allow";
              } else {
                await runAutoReview();
              }
            }
          } else if (applied?.duplicate && plan === "ask") {
            gateDecision = "ask";
          }
          if (context.signal.aborted) return pauseForApproval();
          if (
            siteGate === "new" &&
            newSiteOutcome({ trigger: run.trigger, decision: gateDecision }) === "deny"
          ) {
            if (applied) {
              await deps.prisma.externalEffect.updateMany({
                where: { id: applied.effect.id, status: "intended" },
                data: { status: "denied" },
              });
            }
            return { error: `Fetching ${fetchSite} needs approval, and a webhook run cannot ask.` };
          }

          const needsApproval = gateDecision === "ask";
          const bypassApproval = gateDecision === "allow" && gated;
          let claimedEffect = false;

          const callMediaTool = async (recoverOnly = false) => {
            if (
              (name !== "generate_image" && name !== "generate_video") ||
              isBackgroundRunTrigger(run.trigger) ||
              !mediaGeneration ||
              !deps.artifacts
            )
              return { error: "Media generation is unavailable." };
            const artifacts = deps.artifacts;
            return generateMediaFromTool({
              name,
              args,
              executionId: applied?.effect.id ?? executionId,
              recoverOnly,
              provider: mediaGeneration,
              prisma: deps.prisma,
              context,
              run,
              attach: (output, fileName, job) =>
                attachWorkspaceFileToThread(
                  { prisma: deps.prisma, artifacts, maxUploadSizeBytes: deps.maxUploadSizeBytes },
                  {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    botId: bot.id,
                    groupId: thread.groupId ?? undefined,
                    runId: run.id,
                    filePath: fileName,
                    bytes: output.bytes,
                    operationId: executionId,
                    onAttached: async (tx, artifact) => {
                      const checkpointed = await tx.externalEffect.updateMany({
                        where: {
                          id: job.id,
                          status: { not: "media_completed" },
                          result: { equals: job.result },
                        },
                        data: {
                          status: "media_polling",
                          result: { ...job.result, artifactId: artifact.id },
                        },
                      });
                      if (!checkpointed.count)
                        throw new Error("Media attachment was already checkpointed");
                    },
                  },
                ),
              publish: async (block, jobId, artifactId) => {
                const committed = await deps.prisma.$transaction(async (tx) => {
                  // Commit completion with the message so a restarted poll cannot post twice.
                  const claimed = await tx.externalEffect.updateMany({
                    where: { id: jobId, status: { not: "media_completed" } },
                    data: {
                      status: "media_completed",
                      result: { provider: mediaGeneration.id, artifactId },
                    },
                  });
                  if (!claimed.count) return null;
                  return persistMessageInTransaction(tx, run, "bot", [block]);
                });
                if (committed)
                  await deps.events
                    .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
                    .catch(() => undefined);
              },
            });
          };
          const settleToolUncertainty = async (effectId: string, toolName: string) => {
            if (name === "generate_image" || name === "generate_video") {
              const recovered = await callMediaTool(true);
              if (
                recovered !== undefined &&
                (await completeEffect(deps, effectId, "executing", recovered))
              )
                return recovered;
            }
            return settleUncertainEffect(deps.prisma, effectId, toolName, args);
          };

          const claimOrReturn = async (
            from: "approved" | "intended",
          ): Promise<unknown | undefined> => {
            const claim = from === "approved" ? claimApprovedEffect : claimIntendedEffect;
            if (await claim(deps.prisma, applied!.effect.id)) {
              claimedEffect = true;
              return undefined;
            }
            const current = await deps.prisma.externalEffect.findUnique({
              where: { id: applied!.effect.id },
            });
            if (current) {
              const retryGate = resolveDuplicateEffectGate(current, name);
              if (retryGate.action === "return") return retryGate.result;
              if (retryGate.action === "uncertain") {
                return settleToolUncertainty(applied!.effect.id, name);
              }
            }
            throw uncertainEffectError(name);
          };

          const showApprovalCard = async () => {
            if (!(await renewRunLease(deps, runId, workerId, fence))) {
              // Another worker owns the run now; exit without leaving a local pause card.
              return pauseForApproval();
            }
            await workspaceCheckpoint.flush();
            await persistTurnCheckpoint(executionId);
            await settleRunningHelpers();
            const paused = await deps.events.pauseRunForInput({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId,
              attemptId: attempt.id,
              leaseOwner: workerId,
              leaseFence: fence,
              blocks: [
                buildApprovalAskBlock(
                  applied!.effect.id,
                  name,
                  name === "propose_instructions_update" ? { ...args, botId: bot.id } : args,
                  runSecrets,
                  { reviewReason, summary: fleetSummary },
                ),
              ],
            });
            // pauseRunForInput returning false after a successful renew means the run row no
            // longer matches this worker. Exiting via pauseForApproval() would leave the run
            // stuck in "running" with no ask card — fail instead so the user can retry.
            if (!paused) {
              throw new Error("Could not pause this run for approval; try sending again.");
            }
            if (paused.continuationRunId) {
              await deps.jobs
                .enqueue(runContinueJob(paused.continuationRunId))
                .catch((error) => getLogger().error("steering continuation enqueue", error));
            }
            await notifyRun(deps, run, {
              kind: "help",
              title: `${displayName(bot.name, "Bot")} needs approval`,
              body: `Review before ${name}`,
              botId: bot.id,
              threadId: thread.id,
            });
            return pauseForApproval();
          };
          const requestApproval = () => {
            // Parallel calls can need approval at once. Only the first saves the turn and shows
            // its card; the others wait for that pause. Otherwise a later call's save could make
            // the turn resume a call other than the one the user approved.
            if (approvalRequest) return approvalRequest.then(() => pauseForApproval());
            approvalRequest = showApprovalCard();
            return approvalRequest;
          };

          if (applied?.duplicate) {
            const gate = resolveDuplicateEffectGate(applied.effect, name);
            if (gate.action === "return") {
              if (name === "request_secret") {
                const replacementSecret = await deps.prisma.secret.findFirst({
                  where: {
                    spaceId: run.spaceId,
                    userId: run.userId,
                    kind: runSecretKind(runId),
                  },
                  select: { id: true, createdAt: true },
                });
                if (!replacementSecret) return gate.result;
                // Crash between persist and delete leaves the same OTP row. Do not
                // resubmit it to the connector; only newer rows are replacements.
                const effectUpdatedAt = applied.effect.updatedAt;
                if (
                  !(effectUpdatedAt instanceof Date) ||
                  resolveCompletedSecretLeftover({
                    secretCreatedAt: replacementSecret.createdAt,
                    effectUpdatedAt,
                  }) === "drop_leftover"
                ) {
                  await deps.prisma.secret.delete({
                    where: { id: replacementSecret.id },
                  });
                  return gate.result;
                }
              } else {
                return gate.result;
              }
            }
            if (gate.action === "paused") {
              if (name === "request_secret") {
                const current = await deps.prisma.run.findUnique({
                  where: { id: runId },
                  select: { status: true },
                });
                if (current?.status === "waiting_input") {
                  return pauseForSecret();
                }
                // An intended secret request resumes protected entry below, including
                // recovery after action approval but before the card was committed.
              } else if (!needsApproval) {
                const early = await claimOrReturn("intended");
                if (early !== undefined) return early;
              } else {
                const current = await deps.prisma.run.findUnique({
                  where: { id: runId },
                  select: { status: true },
                });
                if (current?.status === "waiting_input") {
                  return pauseForApproval();
                }
                return requestApproval();
              }
            } else if (gate.action === "uncertain") {
              return settleToolUncertainty(applied.effect.id, gate.toolName);
            } else if (gate.action === "execute") {
              const early = await claimOrReturn("approved");
              if (early !== undefined) return early;
            }
          } else if (needsApproval && applied) {
            return requestApproval();
          } else if (bypassApproval && applied) {
            const early = await claimOrReturn("intended");
            if (early !== undefined) return early;
          }
          // Past the gate: this destination is now one the run was given. A search result's exact
          // URL trusts only that URL, never the rest of its site.
          if (fetchSite && siteGate === "new") (await loadTrustedSites()).add(fetchSite);
          if (viaConnector) {
            const trusted = await loadTrustedConnectors();
            for (const trust of connectorTrusts) trusted.add(trust);
          }
          const persistEffectResult = (result: unknown) =>
            applied
              ? completeEffect(
                  deps,
                  applied.effect.id,
                  claimedEffect ? "executing" : "intended",
                  result,
                )
              : Promise.resolve(true);
          const finish = async (result: unknown) =>
            (await persistEffectResult(result)) ? result : uncertainEffectResult(name, args);
          const appendComputerCommand = (payload: ComputerCommand) =>
            deps.events
              .append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId,
                type: "computer.command",
                payload,
              })
              // The Activity feed is a view; losing an entry must not fail the tool.
              // Output that arrives after the run was cancelled has no history to join.
              .catch((error: unknown) => {
                if (!(error instanceof RunHistoryWriteError)) {
                  getLogger().error("computer command event", error);
                }
              });
          /** Record a finished file/app action for the terminal's Activity view. */
          const recordComputerAction = (
            kind: Exclude<ComputerCommand["kind"], "shell">,
            target: string,
            outcome: { error?: string; bytes?: number } = {},
          ) =>
            appendComputerCommand({
              executionId,
              kind,
              command: redactSecrets(target, runSecrets),
              cwd: ".",
              status: "done",
              exitCode: outcome.error ? 1 : 0,
              output: outcome.error ? redactSecrets(outcome.error, runSecrets) : "",
              ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
            });
          const workspace: RunWorkspace = {
            botId: bot.id,
            computerMode,
            computer: () => getRunComputer("tool", name),
            markDirty: () => workspaceCheckpoint.markDirty(),
            context,
            runSecrets,
          };
          if (name === "computer_observe") {
            if (heldForTakeover) {
              return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return {
                error: "Teaching is in progress. Stop teaching before using the computer.",
              };
            }
            return computerScreenToolResult(async () =>
              formatObservation(
                await deps.sandbox.observe(await getRunComputer("tool", name), context),
              ),
            );
          }
          if (name === "computer_act") {
            if (heldForTakeover) {
              return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return {
                error: "Teaching is in progress. Stop teaching before using the computer.",
              };
            }
            const actions = parseComputerActions(args.actions);
            const visualActionKey = computerVisualActionKey(actions);
            if (unchangedVisualActionBlocked(unchangedVisualStreak, actions)) {
              return finish(unchangedVisualLoopToolResult(unchangedVisualStreak));
            }
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              const result = await deps.sandbox.act(
                await getRunComputer("tool", name),
                {
                  actions,
                  observe: args.observe !== false,
                  settleMs: Number(args.settle_ms ?? 350),
                },
                context,
              );
              return result.observation
                ? formatObservation(
                    result.observation,
                    `completed ${result.completed} computer action${result.completed === 1 ? "" : "s"}`,
                    visualActionKey,
                  )
                : { ok: true, completed: result.completed };
            }, finish);
          }
          if (name === "list_files") return listFilesFromTool(deps.sandbox, workspace, args);
          if (name === "read_file") return readFileFromTool(deps.sandbox, workspace, args);
          if (name === "write_file") {
            const filePath = String(args.path ?? "notes/result.txt");
            if (graphical) {
              const activateRefusal = protectedActivateScriptWriteRefusal(filePath);
              if (activateRefusal) {
                return finish({ error: desktopProtectionGuardMessage(activateRefusal) });
              }
            }
            const content = new TextEncoder().encode(textContentArg(args.content, ""));
            workspaceCheckpoint.markDirty();
            try {
              await deps.sandbox.writeFile(
                await getRunComputer("tool", name),
                { path: resolveBotWorkspacePath(computerMode, bot.id, filePath), content },
                context,
              );
            } catch (error) {
              await recordComputerAction("write_file", filePath, {
                error: error instanceof Error ? error.message : "could not write file",
              });
              throw error;
            }
            await recordComputerAction("write_file", filePath, { bytes: content.byteLength });
            return finish({ ok: true, path: filePath });
          }
          if (name === "generate_image" || name === "generate_video") {
            return finish(await callMediaTool());
          }
          if (name === "render_plot") {
            return renderPlotFromTool(deps, run, args, executionId, workspace, finish);
          }
          if (name === "attach_file") {
            const filePath = String(args.path ?? "");
            const failAttach = async (error: string) => {
              await recordComputerAction("attach_file", filePath, { error });
              return finish({ error, path: filePath });
            };
            if (!deps.artifacts) return failAttach("artifact storage unavailable");
            const storedPath = resolveBotWorkspacePath(computerMode, bot.id, filePath);
            let bytes: Uint8Array;
            try {
              bytes = await deps.sandbox.readFile(
                await getRunComputer("tool", name),
                storedPath,
                context,
                {
                  maxBytes: deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES,
                },
              );
            } catch {
              return failAttach("file not found or unreadable");
            }
            const mimeType = inferAttachmentMimeType(filePath);
            if (!mimeType) return failAttach("unsupported attachment type");
            try {
              const attached = await attachWorkspaceFileToThread(
                {
                  prisma: deps.prisma,
                  artifacts: deps.artifacts,
                  maxUploadSizeBytes: deps.maxUploadSizeBytes,
                },
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                  botId: bot.id,
                  groupId: thread.groupId ?? undefined,
                  runId: run.id,
                  filePath,
                  bytes,
                  operationId: executionId,
                  name: typeof args.name === "string" ? args.name : undefined,
                  description: typeof args.description === "string" ? args.description : undefined,
                },
              );
              await publishMessage(deps, run, "bot", [attached.block]);
              await recordComputerAction("attach_file", filePath);
              return finish({ ok: true, artifactId: attached.artifactId, path: filePath });
            } catch (error) {
              return failAttach(error instanceof Error ? error.message : "could not attach file");
            }
          }
          if (name === "shell") {
            const command = String(args.command ?? args.cmd ?? "");
            const refusal = protectedComputerLifecycleRefusal(command);
            if (graphical && refusal) {
              return finish({ error: desktopProtectionGuardMessage(refusal) });
            }
            const cwd = resolveBotWorkspaceCwd(
              computerMode,
              bot.id,
              args.cwd ? String(args.cwd) : undefined,
            );
            // Loaded per command so a command variable added, replaced, or removed mid-run
            // applies to the next command. Registered for redaction before anything runs.
            const commandEnvironment = await shellCommandEnvironment({
              prisma: deps.prisma,
              secretStore: deps.secretStore,
              scope: run,
              spaceEnvironment: agentEnvironment,
              registerRedactions: registerRunSecrets,
            });
            workspaceCheckpoint.markDirty();
            const commandEvent = {
              executionId,
              kind: "shell" as const,
              command: redactSecrets(command, runSecrets),
              cwd: redactSecrets(cwd ?? ".", runSecrets),
            };
            await appendComputerCommand({
              ...commandEvent,
              status: "running",
              exitCode: null,
              output: "",
            });
            try {
              let latestOutput = "";
              let lastPublishedAt = 0;
              let publishTimer: ReturnType<typeof setTimeout> | undefined;
              const clearPublishTimer = () => {
                if (publishTimer) clearTimeout(publishTimer);
                publishTimer = undefined;
              };
              const publishRunning = (output: string, immediate = false) => {
                latestOutput = output.slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS);
                const send = () => {
                  clearPublishTimer();
                  lastPublishedAt = Date.now();
                  void appendComputerCommand({
                    ...commandEvent,
                    status: "running",
                    exitCode: null,
                    output: latestOutput,
                  });
                };
                if (immediate || Date.now() - lastPublishedAt >= 400) {
                  send();
                  return;
                }
                if (!publishTimer) publishTimer = setTimeout(send, 400);
              };
              const commandOutput = (
                snapshot: { stdout: string; stderr: string },
                withholdPartial: boolean,
              ) => {
                const safe = redactShellStreams(snapshot, runSecrets, { withholdPartial });
                return `${safe.stdout}${safe.stderr}`;
              };
              const computer = await getRunComputer("tool", name);
              const shellEnvironment =
                hostEnvironment ??
                (computer.kind === "desktop"
                  ? await deps.sandbox.environment?.(computer, context)
                  : undefined);
              const observed = await observeShellCommand(
                deps.sandbox.execute(
                  computer,
                  {
                    argv: shellEnvironment
                      ? nativeShellCommandArgv(command, shellEnvironment)
                      : [
                          "bash",
                          "-c",
                          BACKGROUND_WORK_LAUNCH,
                          "rakazo-background-launch",
                          // Marker id must match sleepComputerIfIdle's probe (DB id), not ComputerRef.id
                          // (providerRef via toComputerRef). Scope launches to this run for cancel teardown.
                          storedComputer.id,
                          runId,
                          randomUUID(),
                          command,
                        ],
                    cwd,
                    env:
                      Object.keys(commandEnvironment.env).length > 0
                        ? commandEnvironment.env
                        : undefined,
                    unsetEnv: commandEnvironment.unsetEnv,
                    timeoutMs: sandboxCommandTimeoutMs(),
                  },
                  context,
                ),
                {
                  secrets: runSecrets,
                  onOutput: (snapshot) => {
                    const output = commandOutput(snapshot, true);
                    if (output) publishRunning(output);
                  },
                },
              );
              if (observed.completion) {
                const completion = observed.completion.then(async (final) => {
                  clearPublishTimer();
                  await appendComputerCommand({
                    ...commandEvent,
                    status: "done",
                    exitCode: final.code,
                    output: commandOutput(final, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
                  });
                  return final;
                });
                void completion.catch(() => undefined);
                publishRunning(commandOutput(observed.result, true), true);
                const returned = await finish({
                  stdout: observed.result.stdout,
                  stderr: observed.result.stderr,
                  code: null,
                  running: true,
                  notice: SHELL_STILL_RUNNING_NOTICE,
                });
                if (isRunningShellCommand(returned)) observer?.onShellStillRunning?.(completion);
                return returned;
              }
              clearPublishTimer();
              const redacted = observed.result;
              await appendComputerCommand({
                ...commandEvent,
                status: "done",
                exitCode: redacted.code,
                output: commandOutput(redacted, false).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
              });
              return finish(redacted);
            } catch (error) {
              await appendComputerCommand({
                ...commandEvent,
                status: "done",
                exitCode: 1,
                output: redactSecrets(
                  error instanceof Error ? error.message : "command failed",
                  runSecrets,
                ).slice(-COMPUTER_COMMAND_OUTPUT_MAX_CHARS),
              });
              throw error;
            }
          }
          if (name === "open_path") {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            const requestedPath = String(args.path ?? "");
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              try {
                const result = await deps.sandbox.act(
                  await getRunComputer("tool", name),
                  {
                    actions: [
                      {
                        kind: "open",
                        path: /^https?:\/\//i.test(requestedPath)
                          ? requestedPath
                          : resolveBotWorkspacePath(computerMode, bot.id, requestedPath),
                      },
                    ],
                    observe: true,
                    settleMs: 600,
                  },
                  context,
                );
                await recordComputerAction("open_path", requestedPath);
                return result.observation
                  ? formatObservation(result.observation, `opened ${requestedPath}`)
                  : { ok: true };
              } catch (error) {
                await recordComputerAction("open_path", requestedPath, {
                  error: error instanceof Error ? error.message : "could not open path",
                });
                throw error;
              }
            }, finish);
          }
          if (name === "launch_app") {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            const application = String(args.application ?? "");
            workspaceCheckpoint.markDirty();
            return computerScreenToolResult(async () => {
              try {
                const result = await deps.sandbox.act(
                  await getRunComputer("tool", name),
                  {
                    actions: [
                      {
                        kind: "focus",
                        application,
                        uri: args.uri ? String(args.uri) : undefined,
                      },
                    ],
                    observe: true,
                    settleMs: 600,
                  },
                  context,
                );
                await recordComputerAction("launch_app", application);
                return result.observation
                  ? formatObservation(result.observation, `launched ${application}`)
                  : { ok: true };
              } catch (error) {
                await recordComputerAction("launch_app", application, {
                  error: error instanceof Error ? error.message : "could not launch app",
                });
                throw error;
              }
            }, finish);
          }
          if (name === "remember") {
            const path = String(args.path ?? "").trim() || "MEMORY.md";
            // A fact is added to the document, never replaces it. A concurrent save
            // changes the revision, so re-read and append again.
            for (let attempt = 1; ; attempt += 1) {
              const snapshot = await deps.memory.read(
                { scope: "bot", botId: bot.id, path },
                context,
              );
              const existing = snapshot.documents[0];
              const content = appendMemoryFact(existing?.content ?? "", String(args.content ?? ""));
              if (content === (existing?.content ?? "")) return finish({ ok: true });
              try {
                await deps.memory.commit(
                  {
                    scope: "bot",
                    botId: bot.id,
                    path,
                    content,
                    expectedRevision: existing?.revision ?? 0,
                    sourceRunId: runId,
                    sourceThreadId: thread.id,
                  },
                  context,
                );
                return finish({ ok: true });
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                if (message !== MEMORY_REVISION_CONFLICT_ERROR || attempt >= 3) throw error;
              }
            }
          }
          if (name === "save_shared_memory") {
            const invalid = sharedMemorySaveError(args);
            if (invalid) return finish({ error: invalid });
            const path = String(args.path ?? "").trim();
            // The save replaces the whole document. Pass the revision just read so a
            // concurrent edit is rejected instead of overwritten.
            const snapshot = await deps.memory.read({ scope: "user", path }, context);
            const expectedRevision = snapshot.documents[0]?.revision ?? 0;
            try {
              const saved = await deps.memory.commit(
                {
                  scope: "user",
                  path,
                  content: String(args.content ?? ""),
                  expectedRevision,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              return finish({ ok: true, path: saved.path, revision: saved.revision });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Could not save shared memory.";
              if (message === MEMORY_REVISION_CONFLICT_ERROR) return finish({ error: message });
              throw error;
            }
          }
          if (name === "web_search") {
            const found = await webSearchFromTool(web, context, args);
            // A result's exact URL was chosen by the search index, not by text in this run.
            for (const hit of ("results" in found && found.results) || []) {
              const url = normalizedHttpUrl(hit.url);
              if (url) searchResultUrls.add(url);
            }
            return finish(found);
          }
          if (name === "web_fetch") {
            return finish(await webFetchFromTool(web, context, args));
          }
          if (PAGE_BROWSER_TOOL_NAMES.has(name)) {
            if (heldForTakeover) {
              return finish({ error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE });
            }
            if (await getActiveTeachingSession(deps.prisma, run.spaceId, run.botId)) {
              return finish({
                error: "Teaching is in progress. Stop teaching before using the computer.",
              });
            }
            if (name !== "browser_snapshot") workspaceCheckpoint.markDirty();
            // Pages can echo a filled login (e.g. a username field), so scrub every page result.
            const redactions = () => [...runSecrets];
            const desktopTools =
              graphicalToolsAllowed && builtinOffered(disabledBuiltinTools, "computer_act");
            const tool =
              name === "browser_navigate"
                ? browserNavigateFromTool
                : name === "browser_snapshot"
                  ? browserSnapshotFromTool
                  : null;
            return computerScreenToolResult(async () => {
              const result = tool
                ? redactConnectorPayload(
                    await tool(browser, await getRunComputer("tool", name), context, args, {
                      desktopTools,
                    }),
                    redactions(),
                  )
                : await browserActFromTool(
                    browser,
                    await getRunComputer("tool", name),
                    context,
                    args,
                    {
                      desktopTools,
                      redactions,
                      // Team bots may send only their own folder or shared/ off the computer; a
                      // private computer's helper already confines uploads to its home folder.
                      uploadRoots:
                        computerMode === "team"
                          ? [teamBotWorkspaceDirectory(bot.id), "shared"]
                          : undefined,
                      resolveUploadPath: (path) =>
                        computerMode === "team"
                          ? resolveBotUploadPath(computerMode, bot.id, path)
                          : path,
                      resolveSecretFill: async (step) => {
                        const resolved = await resolveLoginFill({
                          prisma: deps.prisma,
                          secretStore: deps.secretStore,
                          scope: run,
                          name: step.secret,
                          field: step.field,
                        });
                        if ("error" in resolved) return resolved;
                        registerRunSecrets(resolved.redactions);
                        return { text: resolved.text, origin: resolved.origin };
                      },
                    },
                  );
              unchangedVisualStreak = unchangedVisualStreakAfterPageBrowser(
                unchangedVisualStreak,
                name,
                result,
              );
              return result;
            }, finish);
          }

          if (name.startsWith("cloud_agent_")) {
            return finish(
              await executeCloudAgentTool(
                { ...deps, cloudAgent },
                { ...context, operationId: effectKey, botId: bot.id },
                run,
                name,
                args,
              ),
            );
          }
          if (name === "task_catalog") {
            return taskCatalogFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
              tools,
            });
          }
          if (name === "scratchpad_list") {
            return listScratchpadItemsFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              includeDone: Boolean(args.includeDone),
            });
          }
          if (name === "scratchpad_add") {
            const created = await addScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              title: String(args.title ?? ""),
              status: args.status ? String(args.status) : undefined,
              notes: args.notes !== undefined ? String(args.notes) : undefined,
            });
            return finish(created);
          }
          if (name === "scratchpad_update") {
            const updated = await updateScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
              title: args.title !== undefined ? String(args.title) : undefined,
              status: args.status !== undefined ? String(args.status) : undefined,
              notes: args.notes !== undefined ? String(args.notes) : undefined,
            });
            return finish(updated);
          }
          if (name === "scratchpad_complete") {
            const completed = await completeScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
            });
            return finish(completed);
          }
          if (name === "scratchpad_remove") {
            const removed = await removeScratchpadItemFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              itemId: String(args.itemId ?? ""),
            });
            return finish(removed);
          }
          if (name === "board_tickets") {
            return finish(
              await listBoardTickets(deps, {
                spaceId: run.spaceId,
                status: args.status !== undefined ? String(args.status) : undefined,
                assigneeBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
                cursor: args.cursor !== undefined ? String(args.cursor) : undefined,
              }),
            );
          }
          if (name === "ticket_get") {
            return finish(
              await getTicket(deps, {
                spaceId: run.spaceId,
                ref: String(args.ref ?? ""),
              }),
            );
          }
          if (name === "ticket_create") {
            return finish(
              await createTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                title: String(args.title ?? ""),
                description: args.description !== undefined ? String(args.description) : undefined,
                priority: args.priority !== undefined ? String(args.priority) : undefined,
                ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
              }),
            );
          }
          if (name === "ticket_update") {
            return finish(
              await updateTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                id: String(args.id ?? ""),
                title: args.title !== undefined ? String(args.title) : undefined,
                description: args.description !== undefined ? String(args.description) : undefined,
                priority: args.priority !== undefined ? String(args.priority) : undefined,
                status: args.status !== undefined ? String(args.status) : undefined,
                ownerBotId: args.ownerBotId !== undefined ? String(args.ownerBotId) : undefined,
              }),
            );
          }
          if (name === "ticket_comment") {
            return finish(
              await commentTicket(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                id: String(args.id ?? ""),
                body: String(args.body ?? ""),
              }),
            );
          }
          if (name === "schedule_create") {
            const command = commandWatchFromTool(args.watch);
            const refusal =
              command === undefined ? undefined : protectedComputerLifecycleRefusal(command);
            if (graphical && refusal)
              return finish({ error: desktopProtectionGuardMessage(refusal) });
            const created = await createScheduleFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              threadId: thread.id,
              name: String(args.name ?? ""),
              prompt: String(args.prompt ?? ""),
              timezone: args.timezone ? String(args.timezone) : undefined,
              schedule: compactScheduleInput({
                cron: args.cron,
                every: args.every,
                unit: args.unit,
                runAt: args.runAt,
                delayMinutes: args.delayMinutes,
                delaySeconds: args.delaySeconds,
                startAt: args.startAt,
                watch: args.watch,
              }),
            });
            return finish(created);
          }
          if (name === "schedule_update") {
            return finish(
              await updateScheduleFromTool(deps, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                threadId: thread.id,
                ...(thread.groupId ? { scopeThreadId: thread.id } : {}),
                routineId: String(args.routineId ?? ""),
                name: isScheduleValueProvided(args.name) ? String(args.name) : undefined,
                prompt: isScheduleValueProvided(args.prompt) ? String(args.prompt) : undefined,
                active: typeof args.active === "boolean" ? args.active : undefined,
                timezone: isScheduleValueProvided(args.timezone)
                  ? String(args.timezone)
                  : undefined,
                schedule: compactScheduleInput({
                  cron: args.cron,
                  every: args.every,
                  unit: args.unit,
                  runAt: args.runAt,
                  delayMinutes: args.delayMinutes,
                  delaySeconds: args.delaySeconds,
                  startAt: args.startAt,
                }),
              }),
            );
          }
          if (name === "call_user") {
            if (
              messagingChannelRun ||
              thread.groupId ||
              voiceCall ||
              isBackgroundRunTrigger(run.trigger)
            ) {
              return finish({ error: "Calls require a one-to-one chat." });
            }
            return finish(
              await requestUserCall(deps, run, {
                reason: String(args.reason ?? ""),
                opening: String(args.opening ?? ""),
              }),
            );
          }

          if (name === "schedule_list") {
            return listSchedulesFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
            });
          }
          if (name === "schedule_cancel") {
            const cancelled = await cancelScheduleFromTool(deps, {
              spaceId: run.spaceId,
              botId: bot.id,
              userId: run.userId,
              ...(thread.groupId ? { threadId: thread.id } : {}),
              routineId: args.routineId ? String(args.routineId) : undefined,
              name: args.name ? String(args.name) : undefined,
            });
            return finish(cancelled);
          }
          if (name === "skill_read") {
            return skillReadFromTool(
              deps.prisma,
              {
                spaceId: run.spaceId,
                userId: run.userId,
              },
              {
                name: args.name ? String(args.name) : undefined,
                skillId: args.skillId ? String(args.skillId) : undefined,
              },
            );
          }
          if (name === "skill_create") {
            return finish(
              await skillCreateFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  description: args.description ? String(args.description) : undefined,
                  body: args.body ? String(args.body) : undefined,
                  content: args.content ? String(args.content) : undefined,
                },
              ),
            );
          }
          if (name === "skill_update") {
            return finish(
              await skillUpdateFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  skillId: args.skillId ? String(args.skillId) : undefined,
                  newName: args.newName ? String(args.newName) : undefined,
                  description:
                    args.description !== undefined ? String(args.description) : undefined,
                  body: args.body !== undefined ? String(args.body) : undefined,
                  content: args.content ? String(args.content) : undefined,
                },
              ),
            );
          }
          if (name === "skill_delete") {
            return finish(
              await skillDeleteFromTool(
                deps.prisma,
                {
                  spaceId: run.spaceId,
                  userId: run.userId,
                },
                {
                  name: args.name ? String(args.name) : undefined,
                  skillId: args.skillId ? String(args.skillId) : undefined,
                },
              ),
            );
          }
          if (name === "add_mcp_server") {
            return finish(await addMcpServerFromTool(deps, run, bot.id, args, executionId));
          }
          if (name === "recall_memory") {
            return semanticMemory!.recall(
              {
                query: String(args.query ?? ""),
                scope: memoryScope!,
                botId: bot.id,
                ...(thread.historyCompactedUpToSeq == null
                  ? {}
                  : { historyGeneration: thread.historyCompactionGeneration }),
                limit: MAX_RECALLED_MEMORIES,
              },
              context,
            );
          }
          if (name === "search_history" || name === "read_history") {
            const scope = {
              spaceId: run.spaceId,
              userId: run.userId,
              threadId: run.threadId,
              botId: run.botId,
              channelId,
              searchBeforeSeq: historySearchBeforeSeq,
            };
            const response =
              name === "search_history"
                ? await searchHistory(deps.prisma, scope, HistorySearchInputSchema.parse(args))
                : await readHistory(deps.prisma, scope, HistoryReadInputSchema.parse(args));
            const redacted = redactConnectorPayload(response, runSecrets);
            // Redaction can expand short synthetic credentials; never let Pi clip the JSON.
            if (Buffer.byteLength(JSON.stringify(redacted), "utf8") > 11_000) {
              return finish({
                untrusted: true,
                error:
                  "Redacted history exceeds the response budget. Retry with limit 1 or a narrower linked run.",
              });
            }
            return finish(redacted);
          }
          if (name === "save_memory") {
            return finish(
              await semanticMemory!.save(
                {
                  content: String(args.content ?? ""),
                  scope: memoryScope!,
                  botId: bot.id,
                  source: { kind: "durable" },
                },
                context,
              ),
            );
          }
          if (name === "forget_memory") {
            if (!semanticMemory?.forget) {
              return finish({
                error: "This memory provider does not support forgetting individual facts.",
              });
            }
            return finish(
              await semanticMemory.forget(
                {
                  id: String(args.id ?? ""),
                  scope: memoryScope!,
                  botId: bot.id,
                  ...(typeof args.entity === "string" && args.entity.trim()
                    ? { entity: args.entity.trim() }
                    : {}),
                  ...(typeof args.reason === "string" && args.reason.trim()
                    ? { reason: args.reason.trim() }
                    : {}),
                },
                context,
              ),
            );
          }
          if (name === "end_call") {
            return finish(
              await endCallFromTool(
                deps,
                run,
                thread.id,
                bot.id,
                args,
                callClientNonceForRun,
                callEndRun,
              ),
            );
          }
          if (name === "connect_app") {
            await flushProgress();
            await publishMidTurnNarration(true);
            return finish(
              await connectApp(
                deps,
                deps.connectors?.managedProviders?.() ?? [],
                context,
                run,
                args.app,
                applied?.effect.id ?? runScopedToolExecutionId(runId, executionId),
              ),
            );
          }
          if (name === "list_secrets") return listBotSecrets(deps.prisma, run);
          if (name === "forget_secret") {
            const parsed = BotSecretName.safeParse(args.name);
            if (!parsed.success) return finish({ error: "A valid credential name is required." });
            return finish(await forgetBotSecret(deps.prisma, run, parsed.data));
          }
          if (name === "secret_request") {
            try {
              const result = await requestWithBotSecret({
                prisma: deps.prisma,
                secretStore: deps.secretStore,
                scope: run,
                request: args,
                signal: context.signal,
                remote: deps.secretHttp,
                registerRedactions: registerRunSecrets,
              });
              return finish(result);
            } catch {
              return finish({ error: "Invalid authenticated request." });
            }
          }
          if (name === "request_secret") {
            const resolvedSecret = resolveRequestSecretDestination(args);
            if (resolvedSecret.error) return finish({ error: resolvedSecret.error });
            const destination = resolvedSecret.destination;
            const connectionId = resolvedSecret.connectionId;
            if (destination) {
              const existing = await findBotSecret(deps.prisma, run, destination.name);
              if (existing && !sameSecretDestination(existing, destination)) {
                return finish({
                  error: "Remove the existing credential before changing its destination.",
                });
              }
              const conflict = await findCommandVariableConflict(deps.prisma, run, destination);
              if (conflict) {
                return finish({
                  error: `Invalid credential destination — name: ${conflict} is already exported as the same variable. Choose another name.`,
                });
              }
              const submitted = botSecretSubmissionSchema({
                allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
              }).safeParse(applied?.effect.result).data;
              if (
                submitted &&
                sameSecretDestination(
                  normalizeSecretDestination(submitted.credentialSaved),
                  destination,
                )
              ) {
                return finish(
                  existing
                    ? { saved: true, ...botSecretToolView(existing) }
                    : { error: "The saved credential is no longer available." },
                );
              }
              if (existing && args.replace !== true) {
                return finish({ saved: true, ...botSecretToolView(existing) });
              }
              // Action approval authorizes showing the card; it is not a credential submission.
              // Return the claim to intended so the answer transaction can approve the saved value.
              if (claimedEffect) {
                const released = await deps.prisma.externalEffect.updateMany({
                  where: { id: applied!.effect.id, status: "executing" },
                  data: { status: "intended" },
                });
                if (released.count !== 1) return uncertainEffectResult(name);
                claimedEffect = false;
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
              const plaintext = await deps.secretStore.load(
                storedSecret.ciphertext,
                storedSecret.id,
              );
              runSecrets.push(plaintext);
              // Keep the tail the old redactor still holds; a fresh instance drops it.
              pendingProgress += progressRedactor.finish();
              progressRedactor = createStreamingRedactor(runSecrets);
              const purpose = String(args.purpose ?? "otp");
              if (applied && !claimedEffect) {
                if (applied.effect.status === "intended") {
                  const early = await claimOrReturn("intended");
                  if (early !== undefined) return early;
                } else if (applied.effect.status === "approved") {
                  const early = await claimOrReturn("approved");
                  if (early !== undefined) return early;
                }
              }
              const recordedEffect = await recordEffect(deps, run, name, effectKey, args);
              if (recordedEffect?.duplicate) {
                const gate = resolveDuplicateEffectGate(recordedEffect.effect, name);
                if (gate.action === "execute") {
                  const early = await claimOrReturn("approved");
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
                    ? replaceCompletedExternalEffectResult(
                        deps.prisma,
                        applied.effect.id,
                        secretResult,
                      )
                    : persistEffectResult(secretResult),
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
                return (await persistEffectResult(connectedResult))
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
            if (!(await renewRunLease(deps, runId, workerId, fence))) {
              return pauseForSecret();
            }
            await workspaceCheckpoint.flush();
            await persistTurnCheckpoint(executionId);
            await settleRunningHelpers();
            const paused = await deps.events.pauseRunForInput({
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              runId,
              attemptId: attempt.id,
              leaseOwner: workerId,
              leaseFence: fence,
              blocks: [
                {
                  kind: "ask",
                  text: String(args.label ?? "Code"),
                  input: "secret",
                  ...(destination ? { credential: destination } : {}),
                  purpose: normalizeSecretAskPurpose(
                    args.purpose ? String(args.purpose) : undefined,
                  ),
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
                runSecrets,
              ),
              botId: bot.id,
              threadId: thread.id,
            });
            return pauseForSecret();
          }
          if (name === "request_takeover") return { ok: true };
          if (name === "run_subagent") {
            return {
              ok: true,
              result: String(args.task ?? "done."),
            };
          }
          if (name === "propose_instructions_update") {
            if ((nextApprovedTool !== name && !bypassApproval) || !claimedEffect) {
              return finish({ error: "Instruction updates require human approval." });
            }
            const committed = await deps.prisma.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
              await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
              const live = await tx.run.findUnique({ where: { id: runId } });
              if (!mayOpenModelStream(live, workerId, fence, context.signal.aborted)) {
                throw new Error("Instruction update run is no longer active.");
              }
              let undoVersionId: string | null;
              try {
                undoVersionId = await writeBotInstructions(tx, {
                  botId: bot.id,
                  instructions: String(args.instructions),
                  reason: String(args.reason),
                  expectedInstructions: String(args.previousInstructions),
                  proposalRunId: runId,
                });
              } catch (error) {
                if (!(error instanceof InstructionConflictError)) throw error;
                await tx.bot.updateMany({
                  where: { id: bot.id, pendingInstructionsRunId: runId },
                  data: { pendingInstructionsRunId: null },
                });
                return { error: error.message };
              }
              if (!undoVersionId) return null;
              return persistMessageInTransaction(tx, run, "bot", [
                {
                  kind: "ask",
                  text: "Instructions updated",
                  status: "answered",
                  instructionUpdate: {
                    botId: bot.id,
                    before: redactSecrets(String(args.previousInstructions), runSecrets),
                    after: String(args.instructions),
                    reason: String(args.reason),
                    undoVersionId,
                  },
                },
              ]);
            });
            if (committed && "error" in committed) return finish(committed);
            if (committed)
              await deps.events
                .notify(run.threadId, committed.eventSeq, committed.firstResponseRunId)
                .catch((error) =>
                  getLogger().error("instruction update realtime notification", error),
                );
            return finish({ ok: true });
          }
          if (name === "create_space") {
            try {
              // The new Space's rows are outside the run's tenant until it exists.
              const space = await runAsSystem("create a Space for its member", () =>
                createSpaceForMember(deps.prisma, {
                  currentSpaceId: run.spaceId,
                  userId: run.userId,
                  name: String(args.name ?? ""),
                }),
              );
              return finish({ ok: true, spaceId: space.id, name: space.name });
            } catch (error) {
              if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError) {
                return finish({ error: error.message });
              }
              throw error;
            }
          }
          if (name === "spawn_bot") {
            const computerModeArg = args.computer_mode;
            let computerMode: "team" | "dedicated" | undefined;
            if (computerModeArg != null && computerModeArg !== "") {
              const value = String(computerModeArg);
              if (value !== "team" && value !== "dedicated") {
                return finish({
                  error: 'computer_mode must be "team" or "dedicated".',
                });
              }
              computerMode = value;
            }
            const spawned = await spawnBot(deps, {
              spawnedBy: {
                id: bot.id,
                name: bot.name,
                spaceId: bot.spaceId,
                userId: run.userId,
              },
              runId,
              spawnKey: effectKey,
              name: String(args.name ?? ""),
              title: args.title ? String(args.title) : undefined,
              description: args.description ? String(args.description) : undefined,
              instructions: args.instructions ? String(args.instructions) : undefined,
              prompt: args.prompt ? String(args.prompt) : undefined,
              computerMode,
            });
            if ("error" in spawned) return finish(spawned);
            if (!(await persistEffectResult(spawned))) return uncertainEffectResult(name);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: spawned.botId,
                  name: spawned.name,
                  title: spawned.title,
                  status: "created",
                },
              ]);
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.spawned",
                payload: { childBotId: spawned.botId, name: spawned.name },
              });
            } catch (error) {
              getLogger().error("spawned bot notification", error);
            }
            return spawned;
          }
          if (name === "list_fleet") return finish(await listFleet(deps, fleetRun, args));
          if (name === "organize_bot")
            return finish(await organizeBot({ ...deps, runSecrets }, fleetRun, args));
          // Replay hands these the canonical request stored with the approved effect.
          if (name === "create_group") return finish(await createFleetGroup(deps, fleetRun, args));
          if (name === "update_group") return finish(await updateFleetGroup(deps, fleetRun, args));
          if (name === "set_child_instructions") {
            return finish(await setChildInstructions(deps, fleetRun, args));
          }
          if (name === "set_child_bot_model") {
            const modelDeps = { ...fleetPrepareDeps(deps, run), events: deps.events };
            return finish(await setChildBotModel(modelDeps, fleetRun, args));
          }
          if (name === "create_child_routine") {
            return finish(await createChildRoutine(deps, fleetRun, args));
          }
          if (name === "update_bot" && argumentGiven(args.bot_id)) {
            return finish(await updateChildBot({ ...deps, runSecrets }, fleetRun, args));
          }
          if (name === "update_bot") {
            return finish(await updateOwnBotFromTool(deps, run, thread.id, bot, args, context));
          }
          if (name === "message_user") {
            const rawMessage = redactSecrets(String(args.message ?? ""), runSecrets);
            const maxLength = messageUserMaxLength();
            const text = clampUserProgressMessage(rawMessage, maxLength);
            if (!text) return finish({ error: "message is required" });
            const truncated = isProgressMessageTruncated(rawMessage, maxLength);
            await flushProgress();
            await publishMidTurnNarration();
            if (!canPublishDurableProgress()) {
              return finish({
                ok: true,
                note: "This update was not posted. The turn is still fresh, or the chat already has enough interim messages for this run. Do not send more progress updates — keep working and put everything in your final reply.",
              });
            }
            await publishMessage(
              deps,
              run,
              "bot",
              [{ kind: "text", text }],
              true,
              userProgressClientNonce(run.id, midTurnProgressCount++),
            );
            midTurnUserTexts.push(text);
            publishedMidTurnUserMessage = true;
            return finish(
              truncated
                ? {
                    ok: true,
                    truncated: true,
                    note: `This progress update was cut off at ${maxLength} characters and the user only saw the truncated version above — it did NOT deliver your full content. message_user is for short interim beats only, never the final answer. Put your complete answer in your normal final reply instead of relying on this truncated update.`,
                  }
                : { ok: true },
            );
          }
          if (name === "message_bot") {
            const sent = await messageBot(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              {
                bot_id: args.bot_id ? String(args.bot_id) : undefined,
                confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
                message: redactSecrets(String(args.message ?? ""), runSecrets),
                intent: args.intent as
                  | "request"
                  | "result"
                  | "question"
                  | "status"
                  | "fyi"
                  | undefined,
                deliveryKey: effectKey,
              },
            );
            if (!sent.ok) return finish({ error: sent.error });
            return finish({
              ok: true,
              botId: sent.botId,
              name: sent.name,
              note: sent.note,
            });
          }
          if (name === "connect_agent") {
            const result = await connectAgent(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              { address: args.address ? String(args.address) : undefined },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "respond_agent_connection") {
            const result = await respondAgentConnection(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              {
                accept: Boolean(args.accept),
                connectionId: String(args.connection_id ?? ""),
                connectionVersion: Number(args.connection_version ?? 0),
              },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "message_agent") {
            const result = await messageConnectedAgent(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              {
                address: args.address ? String(args.address) : undefined,
                message: redactSecrets(String(args.message ?? ""), runSecrets),
                deliveryKey: effectKey,
              },
            );
            if (!result.ok) return finish({ error: result.error });
            return finish(result);
          }
          if (name === "handoff_to_bot") {
            const groupId = args.group_id ? String(args.group_id).trim() : thread.groupId;
            if (!groupId) return finish({ error: "group_id is required outside a group chat" });
            const result = await handoffToGroupBot(deps, run, groupId, {
              bot_id: args.bot_id ? String(args.bot_id) : undefined,
              confirm_name: args.confirm_name ? String(args.confirm_name) : undefined,
              message: redactSecrets(String(args.message ?? ""), runSecrets),
              deliveryKey: effectKey,
            });
            if ("ok" in result && result.ok && thread.groupId) handedOff = true;
            return finish(result);
          }
          if (name === "archive_bot" || name === "delete_bot") {
            const archived = await archiveSpawnedBot(
              deps,
              {
                spawnedByBotId: bot.id,
                userId: run.userId,
                spaceId: run.spaceId,
                confirmName: String(args.confirm_name ?? args.confirmName ?? ""),
                botId: args.bot_id
                  ? String(args.bot_id)
                  : args.botId
                    ? String(args.botId)
                    : undefined,
              },
              context,
            );
            if ("error" in archived) return finish(archived);
            if (!(await persistEffectResult(archived))) return uncertainEffectResult(name);
            try {
              await publishMessage(deps, run, "bot", [
                {
                  kind: "child_bot",
                  botId: archived.botId,
                  name: archived.name,
                  status: "archived",
                },
              ]);
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                type: "bot.archived",
                payload: { childBotId: archived.botId, name: archived.name },
              });
            } catch (error) {
              getLogger().error("archived bot notification", error);
            }
            return archived;
          }
          if (deps.connector) {
            let result: unknown = { error: `unknown tool ${name}` };
            for await (const event of deps.connector.execute(
              { ...connectorCall, tool: name, args, executionId: effectKey },
              context,
            )) {
              if (event.type === "result") {
                result = event.data;
                const logIds = collectLogIds(event.data);
                for (const logId of logIds) {
                  await deps.events.append({
                    spaceId: run.spaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
              if (event.type === "error") {
                result = { error: event.message };
                for (const logId of event.logIds ?? []) {
                  await deps.events.append({
                    spaceId: run.spaceId,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    type: "effect.recorded",
                    payload: { tool: name, logId },
                  });
                }
              }
            }
            return finish(result);
          }
          return finish({ error: `unknown tool ${name}` });
        };

        // Runtimes may dispatch parallel calls; a run can open only one proposal at a time.
        let instructionProposalInFlight = false;
        const dispatchOneTool = async (...params: Parameters<typeof dispatchTool>) => {
          if (params[0] !== "propose_instructions_update") return dispatchTool(...params);
          if (instructionProposalInFlight)
            return { error: "This bot already has a pending instruction proposal." };
          instructionProposalInFlight = true;
          try {
            return await dispatchTool(...params);
          } finally {
            instructionProposalInFlight = false;
          }
        };
        const applyTool = async (...params: Parameters<typeof dispatchTool>) => {
          try {
            return await dispatchOneTool(...params);
          } finally {
            if (toolResultTaintsRun(params[0])) runTainted = true;
          }
        };

        const pluginLine =
          connectedPlugins.length > 0
            ? `Connected plugins: ${connectedPlugins.map((row) => `${row.displayName} (${row.connectorId}:${row.provider})`).join(", ")}. Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).`
            : "No plugins are connected yet.";
        const taughtSkillIndex = savedSkills.slice(0, 20);
        const taughtSkillsLine =
          taughtSkillIndex.length > 0
            ? `Saved taught skills:\n${taughtSkillIndex
                .map((skill) => {
                  const playbook = parsePlaybook(skill.playbook);
                  const name = skill.name || skill.goal.slice(0, 80);
                  return `- ${name}: ${playbook.whenToUse || skill.goal}`;
                })
                .join(
                  "\n",
                )}\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.`
            : undefined;
        const agentSkillsLine = formatSkillsCatalogInstruction(agentSkills);
        const missingImagesInstruction = missingTurnImagesInstruction(
          turnBlocks,
          currentTurnImages,
        );
        const taskPrompt = expandSkillReferencesInPrompt(
          [task.prompt, attachedFilesPrompt, missingImagesInstruction].filter(Boolean).join("\n\n"),
          agentSkills,
        );
        const invokedSkill = savedSkills.find((skill) =>
          promptInvokesSkill(taskPrompt, skill.name || skill.goal),
        );
        const basePrompt = invokedSkill
          ? `${formatSkillRunPrompt(
              invokedSkill.name || invokedSkill.goal.slice(0, 80),
              parsePlaybook(invokedSkill.playbook),
            )}\n\n${taskPrompt}`
          : taskPrompt;
        if (turnCheckpoint) {
          try {
            const saved = restoreTurnCheckpoint(turnCheckpoint, {
              provider: runModelProvider,
              id: runModelId,
            });
            const unresolved = new Set(unresolvedTurnCheckpointCalls(saved.messages));
            const namedTools = namedAgentTools(tools);
            const available = new Set(namedTools.map((tool) => tool.name));
            if (
              saved.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.content.some(
                    (call) =>
                      call.type === "toolCall" &&
                      unresolved.has(call) &&
                      (saved.executionMode === "sequential" ||
                        call.id === saved.pendingToolCallId) &&
                      !available.has(call.name),
                  ),
              )
            ) {
              turnCheckpoint = undefined;
            } else if (saved.effectOccurrences) {
              effectOccurrences.push(...saved.effectOccurrences);
              const pendingExecutionId = JSON.stringify([
                "pi-tool",
                "main",
                saved.pendingToolCallId,
              ]);
              // Provider IDs can repeat in later responses. Only the restored
              // pending call may consume its saved assignment, exactly once.
              restoredPendingEffect = saved.effectOccurrences.findLast(
                (entry) => entry.executionId === pendingExecutionId,
              );
              for (const { fingerprint, occurrence } of saved.effectOccurrences) {
                mutatingEffectOccurrences.set(
                  fingerprint,
                  Math.max(mutatingEffectOccurrences.get(fingerprint) ?? 0, occurrence + 1),
                );
              }
            } else {
              // Older snapshots have no executor assignments. Retained completed
              // calls still reserve their occurrences before pending calls run.
              for (const message of saved.messages) {
                if (message.role !== "assistant") continue;
                for (const call of message.content) {
                  if (call.type !== "toolCall" || unresolved.has(call)) continue;
                  const tool = namedTools.find((tool) => tool.name === call.name)?.tool;
                  if (tool && tool.name !== "request_secret" && tool.name !== "connect_app")
                    nextMutatingEffectOccurrence(
                      tool.name,
                      call.arguments,
                      JSON.stringify(["pi-tool", "main", call.id]),
                    );
                }
              }
            }
          } catch {
            // Incompatible transcripts use the existing canonical approval replay.
            // Decryption happens earlier and must still fail closed.
            turnCheckpoint = undefined;
          }
        }
        const approvalContinuation = turnCheckpoint
          ? undefined
          : buildApprovalContinuation(
              approvedEffects,
              (request) => redactSecrets(JSON.stringify(request), runSecrets),
              { exposedToolNames: new Set(tools.map((tool) => tool.name)) },
            );
        const replyContext = await loadReplyContext(deps.prisma, thread.id, run.sourceMessageId);
        let userTimeZone: string | null | undefined;
        try {
          userTimeZone = (
            await deps.prisma.user.findUnique({
              where: { id: run.userId },
              select: { timezone: true },
            })
          )?.timezone;
        } catch {
          // Timezone is optional context; a lookup failure must not prevent a run.
        }
        let lateRoutineNote: string | undefined;
        if (run.trigger === "routine" && run.routineId && run.clientNonce) {
          try {
            const routine = await deps.prisma.routine.findUnique({
              where: { id: run.routineId },
              select: { crons: true, timezone: true },
            });
            if (routine)
              lateRoutineNote = lateRoutineRunInstruction(run, routine, executionStartedAt);
          } catch {
            // Lateness is optional context; a lookup failure must not prevent a run.
          }
        }
        const prompt = [
          replyContext,
          run.trigger === "reaction" && replyContext ? undefined : basePrompt,
          takeoverResume?.promptNote,
          approvalContinuation,
          // A hang-up turn is read, not heard: no spoken-reply constraint.
          voiceCall && !callEndRun ? voiceCallInstruction(disabledBuiltinTools) : undefined,
          // Per-turn, not in the system prompt: the timestamp changes every call and would break the cacheable prefix.
          formatCurrentTimeInstruction(new Date(), userTimeZone),
          lateRoutineNote,
        ]
          .filter(Boolean)
          .join("\n\n");
        const historicalContext: AgentRunRequest["history"] = [];
        if (compactedHistory.usedLocalSummary && compactedHistory.summary) {
          historicalContext.push({
            role: "user",
            content: redactSecrets(
              formatCompactedSummary(compactedHistory.summary, thread.historyCompactedUpToSeq!),
              runSecrets,
            ),
          });
        }
        if (recalledMemory) {
          historicalContext.push({
            role: "user",
            content: redactSecrets(recalledMemory, runSecrets),
          });
        }
        const modelImageBudget =
          resolved.maxImagesPerPrompt === undefined
            ? undefined
            : Math.max(0, resolved.maxImagesPerPrompt - (currentTurnImages?.length ?? 0));
        // A text-only model keeps the [image:] marker. Putting image parts in
        // history makes the provider reject a follow-up that used to be text.
        const historyWithImages = modelSeesImages
          ? await withRecentTurnImages(deps, history, historyMessages, context, {
              skipMessageId: currentTurnMessage?.id,
              maxImages: modelImageBudget,
            })
          : history;
        const runtimeHistory = [...historicalContext, ...historyWithImages];
        // Without a roster a bot only knows the bots it spawned itself.
        const [teammates, groupDirectory] = await Promise.all([
          thread.groupId
            ? []
            : deps.prisma.bot.findMany({
                where: {
                  spaceId: run.spaceId,
                  userId: run.userId,
                  archivedAt: null,
                  id: { not: bot.id },
                  thread: { isNot: null },
                },
                select: { id: true, name: true, title: true, description: true },
                orderBy: { createdAt: "asc" },
                take: BOT_DIRECTORY_LIMIT,
              }),
          !thread.groupId ? loadBotGroupDirectory(deps.prisma, run) : undefined,
        ]);
        const botDirectory =
          [renderBotDirectory(teammates), groupDirectory].filter(Boolean).join("\n\n") || undefined;

        if (heldForTakeover) {
          const releasedCheckpoint = takeoverCheckpointOf(
            (
              await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { checkpoint: true },
              })
            )?.checkpoint,
          );
          if (releasedCheckpoint) {
            await requeueComputerRun(deps, runId, workerId, fence, releasedCheckpoint, false);
            return;
          }
        }

        // Stop during setup must not still open the model. A reclaimed lease can
        // leave status "running" under a new owner, and the stream loop only
        // notices cancellation after the provider request has started.
        const beforeModel = await deps.prisma.run.findUnique({
          where: { id: runId },
          select: { status: true, leaseOwner: true, leaseFence: true },
        });
        if (
          !mayOpenModelStream(
            beforeModel,
            workerId,
            fence,
            !leaseValid || Boolean(runAbortController?.signal.aborted),
          )
        ) {
          return;
        }

        let fallbackModels: ModelRoleChoice[] = [];
        if (!scripted) {
          try {
            fallbackModels = (
              await effectiveModelRole(deps.prisma, run, "main", {
                settings,
                deployment: runDeployment,
              })
            ).backups;
          } catch (error) {
            getLogger().warn("Backup models could not be loaded", { runId, error });
          }
        }
        // The running model is not its own backup, unless another account serves it.
        fallbackModels = fallbackModels.filter(
          (candidate) =>
            candidate.provider !== runModelProvider ||
            candidate.modelId !== runModelId ||
            (candidate.credentialId !== undefined && candidate.credentialId !== credential?.id),
        );
        const fallbackKey = (provider: string, modelId: string, credentialId?: string | null) =>
          JSON.stringify([provider, modelId, credentialId ?? null]);
        const fallbackModelKeys = new Set(
          fallbackModels.map((candidate) =>
            fallbackKey(candidate.provider, candidate.modelId, candidate.credentialId),
          ),
        );
        const fallbackModelIds = new Set(
          fallbackModels.map((candidate) => fallbackKey(candidate.provider, candidate.modelId)),
        );
        // Provider kind and model id only: custom endpoints are identified by kind, never host.
        const activeModel = { "model.provider": runModelProvider, "model.id": runModelId };

        try {
          if (checkpointLoadError) throw checkpointLoadError;
          const runtimeEvents = deps.runtime.run(
            {
              botId: bot.id,
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
              // Keep an explicit executor override, but let the runtime select
              // cache-aware context for connections declaring a cache window.
              contextStrategy: deps.contextStrategy,
              instructions: userTurnInstructions({
                botInstructions: runIdentityInstruction(bot, run.trigger),
                groupContext,
                messagingContext,
                redactedMemoryContext: memoryContext
                  ? redactSecrets(memoryContext, runSecrets)
                  : undefined,
                redactedScratchpadContext: scratchpadContext
                  ? redactSecrets(scratchpadContext, runSecrets)
                  : undefined,
                redactedTicketContext: ticketContext
                  ? redactSecrets(ticketContext, runSecrets)
                  : undefined,
                hasHistoricalContext: historicalContext.length > 0,
                historyRetrievalEnabled: contextStrategy !== "current",
                computerInstruction,
                pageBrowserAllowed,
                taskCatalogInstruction,
                workspaceInstruction,
                agentEnvironmentInstruction,
                botDirectory,
                pluginLine,
                agentSkillsLine,
                taughtSkillsLine,
                replyGuidance: runReplyGuidance(run.trigger),
                disabledBuiltinTools,
                offeredFleetTools: offeredFleetTools(builtins),
              })
                .filter((instruction): instruction is string => Boolean(instruction))
                .join("\n\n"),
              history: runtimeHistory,
              currentTurnImages,
              tools,
              model: {
                provider: runModelProvider,
                id: runModelId,
                ...(credential ? { connectionId: credential.id } : {}),
                apiKey: resolved.oauth ? undefined : resolved.apiKey,
                callObserver: resolved.callObserver,
                ...cloudflareRunFields(resolved),
                baseUrl: resolved.baseUrl,
                headers: resolved.headers,
                allowPrivateEndpoint: resolved.allowPrivateEndpoint,
                cacheCapabilities: resolved.cacheCapabilities,
                contextWindow: resolved.contextWindow,

                reasoning: resolved.reasoning,
                maxTokens: resolved.maxTokens,
                acceptsImages: resolved.acceptsImages,
                maxImagesPerPrompt: resolved.maxImagesPerPrompt,
                thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
                oauth: resolved.oauth
                  ? {
                      credential: resolved.oauth,
                      persist: resolved.persistOAuth,
                      retire: resolved.retireOAuth,
                    }
                  : undefined,
              },
              fallbackModels: fallbackModels.map(({ provider, modelId, credentialId }) => ({
                provider,
                id: modelId,
                ...(credentialId ? { connectionId: credentialId } : {}),
              })),
              resolveFallbackModel: fallbackModelKeys.size
                ? async (provider, modelId, connectionId) => {
                    const key = fallbackKey(provider, modelId, connectionId);
                    if (!fallbackModelKeys.has(key))
                      throw new Error("Backup model is not selected");
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
                            candidate.credentialId,
                          ) === key,
                      )?.thinkingLevel ?? null,
                      connectionId,
                    );
                  }
                : undefined,
              onModelChange: async (provider, modelId) => {
                if (!fallbackModelIds.has(fallbackKey(provider, modelId))) {
                  throw new Error("Backup model is not selected");
                }
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
                activeModel["model.provider"] = provider;
                activeModel["model.id"] = modelId;
              },
              resumeFromCheckpoint: takeoverResume?.checkpoint,
              turnCheckpoint,
              onCheckpoint: async (capture, executionId) => {
                pendingTurnCheckpoints.set(executionId, capture);
              },
              resumeToolResult: {
                content: [{ type: "text", text: takeoverResume?.promptNote ?? taskPrompt }],
              },
              script,
              allowSilentEmpty: allowSilentEmptyRun,
              emptyResponseText,
              executeTool: scripted ? undefined : applyTool,
              resolveModel: scripted
                ? undefined
                : (provider, modelId) =>
                    resolveConnectedModel(run, provider, modelId, (values) =>
                      runSecrets.push(...values),
                    ),
              onToolCompleted: (completion) => {
                if (restoredPendingEffect?.executionId === completion.executionId)
                  restoredPendingEffect = undefined;
                if (!completion.paused) pendingTurnCheckpoints.delete(completion.executionId);
                return appendToolCompletionAudit(
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
                ),
            },
            context,
          );
          for await (const event of withRuntimeCleanup(runtimeEvents, runAbortController)) {
            if (approvalPausePending) return;
            if (!leaseValid) return;
            const now = Date.now();
            if (now - lastLeaseCheckAt >= 1_000) {
              lastLeaseCheckAt = now;
              const still = await deps.prisma.run.findUnique({
                where: { id: runId },
                select: { status: true, leaseOwner: true, leaseFence: true, checkpoint: true },
              });
              if (
                !still ||
                still.status === "cancelled" ||
                still.leaseOwner !== workerId ||
                still.leaseFence !== fence
              ) {
                leaseValid = false;
                return;
              }
              const releasedHold = takeoverCheckpointOf(still.checkpoint);
              if (heldForTakeover && releasedHold) {
                await requeueComputerRun(deps, runId, workerId, fence, releasedHold, false);
                leaseValid = false;
                runAbortController?.abort();
                return;
              }
            }

            // Check complete assistant turns so split sentinel chunks are recognized
            // without treating a partial identifier (NO_RESPONSE_POLICY) as silence.
            if (event.type === "tool" || event.type === "takeover") {
              recordExplicitNoResponse(assistantTurnText);
              assistantTurnText = "";
            }
            if (event.type === "text") {
              assistantTurnText += event.text;
              if (assistantTurnBreakPending && event.text) {
                assistantTurnBreakPending = false;
                const separator = assistantTurnSeparator(assembled, event.text);
                if (separator) {
                  assembled += separator;
                  currentTextSegment += separator;
                  pendingProgress += progressRedactor.push(separator);
                }
              }
              assembled += event.text;
              currentTextSegment += event.text;
              toolCallStreak = { key: undefined, count: 0 };
              tryFlushPendingTools();
              pendingProgress += progressRedactor.push(event.text);
              const now = Date.now();
              if (!scripted && pendingProgress && now - lastProgressAt >= 250) {
                await flushProgress();
              }
            } else if (event.type === "turn") {
              assistantTurnBreakPending = true;
            } else if (event.type === "progress") {
              toolCallStreak = { key: undefined, count: 0 };
              if (run.trigger === "routine" || isBackgroundRunTrigger(run.trigger)) continue;
              // Flush batched text deltas first so an activity line cannot land
              // ahead of text the model streamed before the tool call.
              if (pendingProgress) {
                await deps.events.append({
                  spaceId: run.spaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  type: "thread.progress",
                  runId,
                  payload: { delta: pendingProgress, streaming: true },
                });
                pendingProgress = "";
                lastProgressAt = Date.now();
              }
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.progress",
                runId,
                payload: {
                  text: redactSecrets(event.text, runSecrets),
                  ...(event.activity ? { activity: true } : {}),
                },
              });
            } else if (event.type === "ask") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              const safeText = redactSecrets(event.text, runSecrets);
              const safeDetail = event.detail
                ? redactSecrets(event.detail, runSecrets)
                : event.detail;
              const safeActions = event.actions?.map((action) => ({
                id: action.id,
                label: redactSecrets(action.label, runSecrets),
              }));
              await workspaceCheckpoint.flush();
              await persistTurnCheckpoint(event.executionId);
              await settleRunningHelpers();
              const paused = await deps.events.pauseRunForInput({
                spaceId: run.spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId,
                attemptId: attempt.id,
                leaseOwner: workerId,
                leaseFence: fence,
                blocks: [
                  {
                    kind: "ask",
                    text: safeText,
                    detail: safeDetail,
                    status: "pending",
                    actions: safeActions,
                  },
                ],
                // Keep unredacted labels on the run for resume; message blocks stay redacted.
                offeredActions: event.actions,
              });
              if (!paused) return;
              if (paused.continuationRunId) {
                await deps.jobs
                  .enqueue(runContinueJob(paused.continuationRunId))
                  .catch((error) => getLogger().error("steering continuation enqueue", error));
              }
              await notifyRun(deps, run, {
                kind: "help",
                title: `${displayName(bot.name, "Bot")} needs an answer`,
                body: safeText,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "takeover") {
              if (!(await renewRunLease(deps, runId, workerId, fence))) return;
              // The user takes over the computer's screen, so it must be up before the run waits.
              await getRunComputer("takeover");
              const safeReason = redactSecrets(event.reason, runSecrets);
              // Publish pending narration as tagged mid-turn progress so reconciliation
              // does not treat pre-takeover text as the delegated final result.
              await publishMidTurnNarration();
              if (assembled.trim()) {
                const narration = clampUserProgressMessage(redactSecrets(assembled, runSecrets));
                if (narration && canPublishDurableNarration()) {
                  await publishMessage(
                    deps,
                    run,
                    "bot",
                    [{ kind: "text", text: narration }],
                    undefined,
                    userProgressClientNonce(run.id, midTurnProgressCount++),
                  );
                  midTurnUserTexts.push(narration);
                  publishedMidTurnUserMessage = true;
                } else if (narration) {
                  discardedMidTurnNarration = true;
                  lastDiscardedMidTurnNarration = narration;
                }
                assembled = "";
                hasStreamedText = false;
                pendingProgress = "";
              }
              // Give the user a full idle period to answer before the computer may suspend.
              scheduleComputerSleep(deps.jobs, storedComputer.id);
              await publishMessage(
                deps,
                run,
                "bot",
                [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: safeReason }],
                true,
              );
              await workspaceCheckpoint.flush();
              if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, computerLease))) {
                throw new Error("Computer lease expired before takeover");
              }
              await persistTurnCheckpoint(event.executionId);
              await settleRunningHelpers();
              const paused = await deps.events.pauseRunForTakeover({
                spaceId: run.spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId,
                attemptId: attempt.id,
                leaseOwner: workerId,
                leaseFence: fence,
                reason: safeReason,
                computerId: storedComputer.id,
              });
              if (!paused) return;
              retainComputerLease = true;
              await notifyRun(deps, run, {
                kind: "takeover",
                title: `${displayName(bot.name, "Bot")} needs you on the screen`,
                body: safeReason,
                botId: bot.id,
                threadId: thread.id,
              });
              return;
            } else if (event.type === "tool") {
              // Preserve event ordering when the throttle still holds recent narration: the
              // client must see that text before the tool call it describes.
              await flushProgress();
              // Promote streamed narration into a durable, replyable chat message before
              // tools continue, so long turns do not look stalled and stay replyable.
              if (event.name !== "message_user") {
                await publishMidTurnNarration();
              }
              assistantTurnBreakPending = true;
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "agent.tool.called",
                runId,
                payload: { name: event.name, executionId: event.executionId },
              });
              pendingToolNames.push(event.name);
              tryFlushPendingTools();
              const loopGuard = advanceToolCallLoopGuard(toolCallStreak, event.name, event.args);
              toolCallStreak = loopGuard.streak;
              if (loopGuard.stuck) {
                approvedEffectReplays.assertDrained();
                flushPendingTools();
                if (!(await renewRunLease(deps, runId, workerId, fence))) return;
                if (messageSegments.length > 0) {
                  await publishMessage(deps, run, "bot", redactBlocks(messageSegments, runSecrets));
                }
                await workspaceCheckpoint.flush();
                terminalCheckpointComplete = true;
                const stuckText = loopGuardStopText(
                  humanizeToolName(event.name),
                  toolCallStreak.count,
                );
                await settleRunningHelpers();
                const stopped = await deps.events.finalizeRun({
                  spaceId: run.spaceId,
                  threadId: thread.id,
                  botId: bot.id,
                  runId,
                  taskId: run.taskId,
                  attemptId: attempt.id,
                  leaseOwner: workerId,
                  leaseFence: fence,
                  outcome: "completed",
                  blocks: isBackgroundRunTrigger(run.trigger)
                    ? []
                    : [{ kind: "text", text: stuckText }],
                });
                if (!stopped) return;
                stopHeartbeatAfterCompletion();
                if (run.trigger === "routine" && run.routineId) {
                  await clearRoutineBackoff(deps, run.routineId);
                }
                if (stopped.continuationRunId) {
                  await deps.jobs
                    .enqueue(runContinueJob(stopped.continuationRunId))
                    .catch((error) => getLogger().error("steering continuation enqueue", error));
                }
                if (run.trigger === "bot_message") {
                  await returnBotMessageOutcome(
                    deps,
                    { ...run, sourceMessageId: run.sourceMessageId },
                    { id: bot.id, name: bot.name },
                    stuckText,
                    "result",
                    { forceUnread: true },
                  ).catch((error) => getLogger().error("bot message loop-guard return", error));
                }
                runAbortController?.abort();
                return;
              }
              if (scripted) {
                const startedAt = Date.now();
                try {
                  const result = await applyTool(event.name, event.args, event.executionId);
                  await appendToolCompletionAudit(
                    deps,
                    {
                      spaceId: run.spaceId,
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                    },
                    toolCompletionFromResult(
                      {
                        name: event.name,
                        executionId: event.executionId,
                        durationMs: Date.now() - startedAt,
                      },
                      result,
                    ),
                    runSecrets,
                  );
                  if (isToolPauseResult(result)) return;
                } catch (error) {
                  await appendToolCompletionAudit(
                    deps,
                    {
                      spaceId: run.spaceId,
                      threadId: thread.id,
                      botId: bot.id,
                      runId,
                    },
                    {
                      name: event.name,
                      executionId: event.executionId,
                      durationMs: Date.now() - startedAt,
                      error,
                    },
                    runSecrets,
                  );
                  throw error;
                }
              }
            } else if (event.type === "subagent") {
              const safeTask = redactSecrets(event.task, runSecrets);
              const safeProgress = event.progress
                ? redactSecrets(event.progress, runSecrets)
                : undefined;
              const safeResult = event.result ? redactSecrets(event.result, runSecrets) : undefined;
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "thread.subagent",
                runId,
                payload: {
                  agentId: event.agentId,
                  name: event.name,
                  task: safeTask,
                  status: event.status,
                  progress: safeProgress,
                  result: safeResult,
                },
              });
              if (event.status === "running") {
                runningHelpers.set(event.agentId, {
                  agentId: event.agentId,
                  name: event.name,
                  task: safeTask,
                  status: event.status,
                  progress: safeProgress,
                });
              } else {
                runningHelpers.delete(event.agentId);
              }
              if (event.status === "completed" || event.status === "failed") {
                publishedTerminalSubagent ||= !subagentMarksUnread(
                  run.trigger,
                  event.status,
                  peerMessage?.repliesToRequest === true,
                );
                await publishMessage(
                  deps,
                  run,
                  "bot",
                  [
                    {
                      kind: "subagent",
                      agentId: event.agentId,
                      name: event.name,
                      task: safeTask,
                      status: event.status,
                      progress: safeProgress,
                      result: safeResult,
                    },
                  ],
                  subagentMarksUnread(
                    run.trigger,
                    event.status,
                    peerMessage?.repliesToRequest === true,
                  ),
                );
              }
            } else if (event.type === "usage" && !event.accounted) {
              await recordUsage(deps.prisma, event, {
                spaceId: run.spaceId,
                botId: bot.id,
                userId: run.userId,
                runId,
                parentRunId: runId,
                operationId: runId,
              });
            } else if (event.type === "done") {
              recordExplicitNoResponse(event.text ?? "");
              if (!assembled && event.text) {
                if (publishedMidTurnUserMessage || discardedMidTurnNarration) {
                  // Mid-turn narration was already published or discarded (routines).
                  // Post-tool finals are streamed into assembled; do not restore
                  // cumulative done.text (clamp/redaction make substring stripping brittle).
                } else {
                  assembled = event.text;
                  currentTextSegment += event.text;
                }
              }
            }
          }

          recordExplicitNoResponse(assistantTurnText);
          runComputer.throwIfFailed();
          if (approvalPausePending || !leaseValid) return;
          approvedEffectReplays.assertDrained();
          pendingProgress += progressRedactor.finish();
          await flushProgress();

          for (const turn of script ?? []) {
            for (const file of turn.files ?? []) {
              workspaceCheckpoint.markDirty();
              await deps.sandbox.writeFile(
                await getRunComputer("script"),
                {
                  path: resolveBotWorkspacePath(computerMode, bot.id, file.path),
                  content: new TextEncoder().encode(file.content),
                },
                context,
              );
            }
            for (const mem of turn.memory ?? []) {
              await deps.memory.commit(
                {
                  scope: mem.scope,
                  botId: mem.scope === "bot" ? bot.id : undefined,
                  path: mem.path,
                  content: mem.content,
                  sourceRunId: runId,
                  sourceThreadId: thread.id,
                },
                context,
              );
              await deps.events.append({
                spaceId: run.spaceId,
                threadId: thread.id,
                botId: bot.id,
                type: "memory.revised",
                runId,
                payload: { path: mem.path, scope: mem.scope },
              });
            }
          }

          await workspaceCheckpoint.flush();
          terminalCheckpointComplete = true;

          // Preserve the last held-back preview as a normal final reply when the
          // model supplies none, unless it chose silence or already delivered that text.
          // Persisting peer results here also lets outcome delivery retry after completion.
          recordExplicitNoResponse(lastDiscardedMidTurnNarration);
          if (
            !isBackgroundRunTrigger(run.trigger) &&
            !handedOff &&
            !explicitNoResponse &&
            !assembled.trim() &&
            lastDiscardedMidTurnNarration &&
            !midTurnUserTexts.includes(lastDiscardedMidTurnNarration)
          ) {
            assembled = lastDiscardedMidTurnNarration;
            currentTextSegment = assembled;
          }
          flushPendingTools();
          // Silent-allowed runs can choose an explicit NO_RESPONSE or finish empty.
          // Other runs still drop a stray sentinel at the edges of a real reply.
          const silentReply = allowSilentEmptyRun
            ? stripNoResponseReply(assembled, messageSegments)
            : stripStrayNoResponse(assembled, messageSegments);
          let completionBlocks = silentReply.blocks;
          if (!silentReply.assembled || isBackgroundRunTrigger(run.trigger)) {
            // Mid-turn progress already posted durable chat messages; skip the empty
            // "…" fallback so we do not add a junk final bubble. Delegated bot_message
            // runs still return via botMessageOutcomeFromMidTurn below (status when
            // only progress was posted, result when a final reply exists). Exact
            // NO_RESPONSE finals are treated as empty before this fallback runs.
            completionBlocks = completionMessageSegments(completionBlocks, {
              allowSilentEmpty: allowSilentEmptyRun || publishedMidTurnUserMessage,
              emptyResponseText,
              suppressOutput: handedOff || isBackgroundRunTrigger(run.trigger),
              skipEmptyFallback: publishedTerminalSubagent || publishedMidTurnUserMessage,
            });
          }
          const blocks = handedOff
            ? []
            : finalBlocksAfterMidTurnProgress(
                redactBlocks(completionBlocks, runSecrets),
                publishedMidTurnUserMessage || runAllowsSilentEmpty(run.trigger),
              );
          const text = handedOff
            ? ""
            : redactSecrets(completionNotificationBody(silentReply.assembled, blocks), runSecrets);
          if (containsSecret(text, runSecrets)) {
            throw new Error("refusing to persist a secret in the thread");
          }
          // Tool steps succeeded and the only completion text is the synthetic
          // empty notice. That is a missed final answer or a swallowed provider
          // failure, not a successful delegated summary.
          if (
            !handedOff &&
            !silentReply.assembled.trim() &&
            emptyDelegatedToolTurnShouldFail(completionBlocks)
          ) {
            throw new Error(TOOL_STEPS_WITHOUT_RESPONSE);
          }
          if (!(await renewRunLease(deps, runId, workerId, fence))) return;
          const botMessageOutcome =
            run.trigger === "bot_message"
              ? botMessageOutcomeFromMidTurn(text, midTurnUserTexts)
              : null;
          await settleRunningHelpers();
          const completed = await deps.events.finalizeRun({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
            outcome: "completed",
            blocks,
            markUnread: completionMarksUnread(
              run.trigger,
              text,
              peerMessage?.repliesToRequest === true,
            ),
          });
          if (!completed) return;
          stopHeartbeatAfterCompletion();
          if (run.trigger === "routine" && run.routineId) {
            await clearRoutineBackoff(deps, run.routineId);
          }
          if (screenRelease) screenRelease.keepWarm = true;
          if (completed.continuationRunId) {
            await deps.jobs
              .enqueue(runContinueJob(completed.continuationRunId))
              .catch((error) => getLogger().error("steering continuation enqueue", error));
          }
          if (botMessageOutcome) {
            // Prefer the final reply. If the turn only posted mid-turn progress, return that
            // text explicitly as status. Delivery uses a stable auto-outcome key; mark
            // botOutcomeReturnedAt only after a successful (or intentionally skipped) return
            // so a crash or failed delivery stays visible to the reconciler.
            await returnBotMessageOutcome(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              botMessageOutcome.text,
              botMessageOutcome.intent,
            ).catch((error) => getLogger().error("bot message result return", error));
          }
          const notifyBody = completionNotificationPreview(text);
          if (
            runSendsFinishNotification(run.trigger) &&
            notifyBody &&
            !completed.continuationRunId
          ) {
            await notifyRun(deps, run, {
              kind: "completion",
              title: `${displayName(bot.name, "Bot")} finished`,
              body: notifyBody,
              botId: bot.id,
              threadId: thread.id,
            });
          }
          // Last, and never fatal: the run is already finalized, so a failure here must not reach
          // the catch block below, where a second finalizeRun would match no rows and silently
          // skip the completion notification.
          try {
            const updatedThread = await deps.prisma.thread.findUniqueOrThrow({
              where: { id: thread.id },
              select: {
                nextMessageSeq: true,
                historyCompactedUpToSeq: true,
              },
            });
            if (
              contextStrategy === "current" &&
              shouldEnqueueCompaction(
                updatedThread.nextMessageSeq,
                updatedThread.historyCompactedUpToSeq,
                HISTORY_WINDOW_SIZE,
                COMPACTION_BATCH_SIZE,
              )
            ) {
              await deps.jobs.enqueue(historyCompactJob(thread.id));
            }
          } catch (error) {
            getLogger().error("history.compact enqueue failed", error);
          }
        } catch (caughtError) {
          let error = caughtError;
          // A refused account limit needs user/operator action, not setup-job retries.
          // Keep the provisioning error even if aborting the model masked it.
          try {
            runComputer.throwIfFailed();
          } catch (computerError) {
            if (!(computerError instanceof SandboxRateLimitError)) throw computerError;
            error = computerError;
          }
          if (!terminalCheckpointComplete) {
            await workspaceCheckpoint.flush().catch(() => undefined);
          }
          const message = redactSecrets(userRunError(error), runSecrets);
          // Reply text the user watched stream in since the last saved message stays in the
          // thread, above the error, instead of vanishing with the live row.
          recordExplicitNoResponse(assistantTurnText);
          const partialText =
            scripted || handedOff || explicitNoResponse || !runPromotesMidTurnNarration(run.trigger)
              ? ""
              : redactSecrets(
                  extractNarrationText(messageSegments, currentTextSegment).text,
                  runSecrets,
                ).trim();
          const partialReply =
            partialText && !containsSecret(partialText, runSecrets)
              ? [{ kind: "text" as const, text: partialText }]
              : [];
          await settleRunningHelpers();
          const failed = await deps.events.finalizeRun({
            spaceId: run.spaceId,
            threadId: thread.id,
            botId: bot.id,
            runId,
            taskId: run.taskId,
            attemptId: attempt.id,
            leaseOwner: workerId,
            leaseFence: fence,
            outcome: "failed",
            error: message,
            ...(partialReply.length > 0 ? { partialReply } : {}),
          });
          if (!failed) return;
          if (
            error instanceof TransientModelError ||
            error instanceof ModelAccountError ||
            error instanceof ModelOutputError ||
            error instanceof SandboxRateLimitError
          ) {
            // Provider outages that outlasted retries, provider accounts, plans and model
            // choices the user fixes, unusable model output and the computer provider's own
            // rate limit are not server faults; the run error already tells the user what to do.
            getLogger().warn("run.failed", {
              "run.outcome": "failed",
              "run.failure": error.name,
              reason: message,
              ...activeModel,
            });
          } else {
            getLogger().error(
              "run.failed",
              sanitizedError(error, (text) => redactSecrets(text, runSecrets)),
              {
                "run.outcome": "failed",
                ...activeModel,
              },
            );
          }
          if (failed.continuationRunId) {
            await deps.jobs
              .enqueue(runContinueJob(failed.continuationRunId))
              .catch((error) => getLogger().error("steering continuation enqueue", error));
          }
          if (run.trigger === "bot_message") {
            await returnBotMessageOutcome(
              deps,
              { ...run, sourceMessageId: run.sourceMessageId },
              { id: bot.id, name: bot.name },
              `Could not complete the delegated request: ${message}`,
              "status",
              { forceUnread: true },
            ).catch((returnError) => getLogger().error("bot message failure return", returnError));
          }
          // A refusal of the deployment's own key is the operator's problem, not the user's.
          if (
            run.trigger === "routine" &&
            run.routineId &&
            resolved.ownCredential &&
            isModelAccountRefusal(error)
          ) {
            await backOffRoutineAfterAccountError(deps, run.routineId);
          }
          const retrying =
            !failed.continuationRunId && (await scheduleRoutineRetry(deps, run, error));
          if (runSendsFinishNotification(run.trigger) && !failed.continuationRunId && !retrying) {
            await notifyRun(deps, run, {
              kind: "failure",
              title: `${displayName(bot.name, "Bot")} failed`,
              body: message,
              botId: bot.id,
              threadId: thread.id,
            });
          }
        }
      } catch (setupError) {
        const computerBusy = setupError instanceof ComputerBusyError;
        const retryForever = computerBusy || isTooManyDatabaseConnections(setupError);
        const setupMessage = redactSecrets(userRunError(setupError), runSecrets);
        const reportedSetupError = sanitizedError(setupError, (text) =>
          redactSecrets(text, runSecrets),
        );
        if (!computerBusy) getLogger().error("run setup failed", reportedSetupError);
        // The job reconciler re-enqueues a queued run whose job ran out of attempts, so a
        // setup that fails every time would retry forever. End the run instead.
        if (
          !retryForever &&
          (await setupFailureStreak(deps.prisma, runId)) >= RUN_SETUP_FAILURE_LIMIT - 1
        ) {
          const bot = await deps.prisma.bot.findUnique({
            where: { id: run.botId },
            select: { name: true },
          });
          await failRunBeforeTurn(
            deps,
            run,
            bot?.name ?? "",
            { attemptId: attempt.id, workerId, fence },
            setupMessage,
          );
          return;
        }
        const released = await writeComputerRunRequeue(
          deps,
          runId,
          workerId,
          fence,
          resumeCheckpoint,
          heldForTakeover,
          retryForever ? null : "Run setup failed; retrying",
        );
        if (released) {
          await deps.prisma.attempt.update({
            where: { id: attempt.id },
            data: {
              status: "setup_failed",
              error: retryForever ? null : "Run setup failed; retrying",
              finishedAt: new Date(),
            },
          });
          if (retryForever || dispatchHandedOff) {
            await deps.jobs.enqueue({
              ...runContinueJob(runId),
              availableAt: new Date(Date.now() + computerRetryDelay(fence)),
            });
            return;
          }
          throw new Error("Run setup failed; retrying", { cause: reportedSetupError });
        }
      } finally {
        getLogger().info("run.computer", {
          "run.id": runId,
          trigger: run.trigger,
          reason: computerUseReason,
          tool: computerUseTool,
          ready: Boolean(screenRelease),
        });
        detachShutdown?.();
        clearInterval(heartbeat);
        if (!retainComputerLease) {
          if (screenRelease) {
            const releaseContext = screenRelease.keepWarm
              ? { ...screenRelease.context, keepScreenWarm: true }
              : screenRelease.context;
            await deps.sandbox
              .releaseScreen?.(screenRelease.computer, releaseContext)
              .catch(() => undefined);
          }
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
        }
        await deps.prisma.attempt
          .updateMany({
            where: { id: attempt.id, status: "running" },
            data: { status: "interrupted", finishedAt: new Date() },
          })
          .catch(() => undefined);
        await settleRunningHelpers();
      }
    },
  };
}
