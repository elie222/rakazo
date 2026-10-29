import type { AgentRunRequest, SemanticMemoryProvider } from "@rakazo/adapter-kit";
import {
  DEFAULT_CONTEXT_STRATEGY,
  isModelCredentialRejected,
  runContinueJob,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { MessageBlock, ModelRoleChoice, RunStatus } from "@rakazo/contracts";
import { disabledBuiltinToolSet } from "@rakazo/contracts";
import {
  assertTransition,
  botMessageAllowsSilence,
  expandSkillReferencesInPrompt,
  formatSkillRunPrompt,
  formatSkillsCatalogInstruction,
  isBackgroundRunTrigger,
  isCallClientNonce,
  isMessagingChannelRun,
  isOwnerStartedRun,
  isTerminal,
  MISSING_MODEL_RUN_ERROR,
  MODEL_ACCESS_REQUIRED_RUN_ERROR,
  messagingChannelId,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  nextFence,
  promptInvokesSkill,
  redactSecrets,
  renderBotDirectory,
  userRunError,
  userTurnMessageForRun,
} from "@rakazo/core";
import {
  effectiveMemoryScope,
  isPartialReplyClientNonce,
  isTooManyDatabaseConnections,
  loadRunHistoryMessages,
  loadRunTurnCheckpoint,
  parseComputerMode,
  readRunTimingFields,
  recordUsage,
  settleReleasedTakeoverCards,
  spaceHasModelAccess,
} from "@rakazo/db";
import { enrichLogContext, getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { formatAgentEnvironmentInstruction } from "./agent-environment.js";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { PARTIAL_REPLY_NOTE } from "./automated-messages.js";
import { loadBotMessageContext } from "./bot-messages.js";
import {
  commandCredentialRedactions,
  loadBotCommandEnvironment,
  loadLoginPasswordRedactions,
  loadRunLoginRedactions,
} from "./bot-secrets.js";
import { createBrowserProvider } from "./browser-provider-factory.js";
import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";
import { cloudAgentsEnabled } from "./cloud-agent-factory.js";
import { mergeConnectedPlugins, needsLivePluginSync } from "./composio-connector.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import {
  acquireComputerExecutionLease,
  acquireDedicatedScreenLeaseFence,
  ComputerBusyError,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  screenLeaseIdForRun,
} from "./computer-lifecycle.js";
import { teamBotWorkspaceDirectory } from "./computer-support.js";
import { checkpointRunComputerWorkspace } from "./computer-workspace.js";
import {
  connectedContext,
  loadLivePluginSlugs,
  persistLivePluginConnections,
  selectRunConnections,
} from "./connection-context.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { resolveDeploymentModel } from "./deployment-model.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FleetRun } from "./fleet-tools.js";
import { loadBotGroupDirectory, loadGroupContext } from "./group-handoff.js";
import {
  formatCompactedSummary,
  formatRecalledMemory,
  historyWindowSize,
  LEGACY_HISTORY_WINDOW_SIZE,
  MAX_RECALLED_MEMORIES,
  selectCompactedHistory,
} from "./history-compaction.js";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { loadAgentMemoryContext } from "./memory-context.js";
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
import { modelAcceptsImageInput } from "./model-vision.js";
import { paymentWalletConnected } from "./payment-wallets.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import { loadPurchaseRedactions } from "./purchase-service.js";
import { loadReplyContext, messageToAgentHistoryText } from "./reply-context.js";
import { backOffRoutineAfterAccountError } from "./routine-backoff.js";
import { lateRoutineRunInstruction } from "./routine-lateness.js";
import { lazyRunComputer } from "./run-computer.js";
import type {
  RunComputerUseState,
  RunContext,
  RunLeaseState,
  RunningHelper,
  RunState,
} from "./run-context.js";
import { restoreTurnCheckpointEffects, settleRunningHelpers } from "./run-context.js";
import { APPROVED_EFFECT_REPLAY_ORDER, buildApprovalContinuation } from "./run-effects.js";
import {
  BOT_DIRECTORY_LIMIT,
  dockerComputerToolInstruction,
  persistentComputerInstruction,
  runIdentityInstruction,
  threadContextForRun,
  userTurnInstructions,
  voiceCallInstruction,
} from "./run-instructions.js";
import {
  computerRetryDelay,
  createRunWorkspaceCheckpoint,
  failRunBeforeTurn,
  mayOpenModelStream,
  RUN_SETUP_FAILURE_LIMIT,
  renewRunLease,
  requeueComputerRun,
  requeueRunAfterShutdown,
  setupFailureStreak,
  startNextWaitingRun,
  writeComputerRunRequeue,
} from "./run-lifecycle.js";
import {
  cloudflareRunFields,
  isTerminalModelSetupError,
  modelCreditBillingEnabled,
  resolveConnectedModelKey,
  resolveConnectedRunModel,
  resolveModelKey,
  resolveRunModel,
  runtimeFallbackModel,
} from "./run-model.js";
import { createReplyState } from "./run-progress.js";
import { DELEGATED_EMPTY_NOTICE, runAllowsSilentEmpty, runReplyGuidance } from "./run-replies.js";
import {
  notifyRoutineRetryAttemptsExhausted,
  retryRoutineRun,
  wakeRoutine,
} from "./run-routines.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  offeredFleetTools,
  selectBuiltinToolsForRun,
} from "./run-tool-selection.js";
import { applyTool } from "./run-tools.js";
import { historyMyChatsAllowed } from "./run-tools-memory.js";
import type { UserComputerState } from "./run-tools-user-computer.js";
import { USER_COMPUTER_SHELL_TOOL, userComputerOwner } from "./run-tools-user-computer.js";
import { createRunTrustLoaders } from "./run-trust.js";
import { completeRun, consumeRunEvents, failRun } from "./run-turn.js";
import {
  claimRunSteering,
  loadCurrentTurnImages,
  missingTurnImagesInstruction,
  RECENT_TURN_IMAGE_TURNS,
  withRecentTurnImages,
} from "./run-turn-images.js";
import { loadAgentScratchpadContext } from "./scratchpad-context.js";
import { inferScript } from "./scripted-runtime.js";
import { listAgentSkillRecords } from "./skill-tools.js";
import {
  continueRunClaimFence,
  refreshTakeoverContinuePlan,
  takeoverCheckpointOf,
  takeoverContinuePlan,
} from "./takeover-resume.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.js";
import { parsePlaybook } from "./teaching-session.js";
import {
  currentTurnFilesInstruction,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeRecentThreadFiles,
  recentThreadFilesInstruction,
} from "./thread-artifacts.js";
import { loadAgentTicketContext } from "./ticket-context.js";
import { appendToolCompletionAudit } from "./tool-completion-audit.js";
import { createWebProvider } from "./web-provider-factory.js";

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
      // A stopping process must not claim work it cannot finish. The row stays
      // queued or expired for a worker that is still running.
      if (deps.shutdownSignal?.aborted) return;
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
      let { resumeCheckpoint, heldForTakeover, takeoverResume } = takeoverContinuePlan(run);

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
          workerId,
          runFence: fence,
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
        // Maintenance or suspension sends no release, so only a held lease waits for one.
        const heldByAnotherRun = await deps.prisma.computerExecutionLease.findFirst({
          where: {
            computerId: leaseTarget.computerId,
            botId: run.botId,
            runId: { not: runId },
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        await requeueComputerRun(
          deps,
          runId,
          workerId,
          fence,
          resumeCheckpoint,
          heldForTakeover,
          Boolean(heldByAnotherRun),
        );
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

      const lease: RunLeaseState = {
        valid: true,
        completed: false,
        lastCheckAt: 0,
        retainComputer: false,
      };
      const computerUse: RunComputerUseState = {
        reason: "none",
        tool: undefined,
        screenRelease: undefined,
      };
      let runAbortController: AbortController | null = null;
      const runningHelpers = new Map<string, RunningHelper>();
      const settleHelpers = () => settleRunningHelpers(deps, run, runningHelpers);

      let detachShutdown: (() => void) | undefined;
      const heartbeat = setInterval(() => {
        if (lease.completed) return;
        void Promise.all([
          renewRunLease(deps, runId, workerId, fence),
          renewComputerExecutionLease(deps.prisma, computerLease),
        ])
          .then(([runRenewed, computerRenewed]) => {
            if (lease.completed) return;
            if (!runRenewed || !computerRenewed) {
              lease.valid = false;
              runAbortController?.abort();
            }
          })
          .catch(() => {
            if (lease.completed) return;
            lease.valid = false;
            runAbortController?.abort();
          });
      }, 60_000);
      heartbeat.unref?.();
      const stopHeartbeatAfterCompletion = () => {
        lease.completed = true;
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
          initialBotCommandEnvironment,
          savedLoginPasswordRedactions,
          purchaseRedactions,
          runLoginRedactions,
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
          loadBotCommandEnvironment(deps.prisma, deps.secretStore, run),
          loadLoginPasswordRedactions(deps.prisma, deps.secretStore, run),
          deps.paymentWallet ? loadPurchaseRedactions(deps, run) : [],
          loadRunLoginRedactions(deps.prisma, deps.secretStore, run, run.id),
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
        // Encoded forms too: read_file redacts with these values before any shell command runs.
        runSecrets.push(...commandCredentialRedactions(initialBotCommandEnvironment));
        // A login filled in an earlier run may still be on its page, and anything this run reads
        // or is given may contain it, so every run hides its saved passwords before the model runs.
        runSecrets.push(
          ...savedLoginPasswordRedactions,
          ...purchaseRedactions,
          ...runLoginRedactions,
        );
        const agentEnvironmentInstruction = formatAgentEnvironmentInstruction(
          initialBotCommandEnvironment,
        );
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
        if (!lease.valid) runAbortController.abort();
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
        // A run owns its source message and steering bound to it, including waiting-input
        // replies. message.runId alone is display linkage: a send during background work
        // points at that run but waits for its continuation. Read independently of history.
        const currentRunImageMessages = await deps.prisma.message.findMany({
          where: {
            threadId: thread.id,
            OR: [
              ...(run.sourceMessageId ? [{ id: run.sourceMessageId }] : []),
              { steeringMessages: { some: { runId, botId: run.botId } } },
            ],
            role: "user",
            blocks: { array_contains: [{ kind: "image" }] },
          },
          select: { id: true, blocks: true },
          orderBy: { seq: "asc" },
        });
        // The content extension decrypts imageHandling after filtering on plain kind.
        const confirmedRunImages = currentRunImageMessages.flatMap((message) =>
          (message.blocks as MessageBlock[]).filter(
            (block) => block.kind === "image" && block.imageHandling === "confirm",
          ),
        );
        const currentRunRequiresImageInput = confirmedRunImages.length > 0;
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
        const selectedProvider = selected.provider ?? runtimeFallback?.provider;
        const selectedModelId = selected.id ?? runtimeFallback?.id;
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
        const modelAccessDenied = async () =>
          (await modelCreditBillingEnabled(deps)) &&
          !(await spaceHasModelAccess(deps.prisma, run.spaceId));
        const scripted = deps.runtime.describe().capabilities.scripted;
        let backupChoices: Promise<ModelRoleChoice[]> | undefined;
        const loadBackups = () =>
          (backupChoices ??= scripted
            ? Promise.resolve([])
            : effectiveModelRole(deps.prisma, run, "main", {
                settings,
                deployment: runDeployment,
              }).then(
                (role) => role.backups,
                (error: unknown) => {
                  getLogger().warn("Backup models could not be loaded", { runId, error });
                  return [];
                },
              ));
        // Backups that could not start here are not offered again once the model runs.
        const backupsUnavailable = new Set<ModelRoleChoice>();
        // A main model with no connection, or whose provider refused its sign-in, runs on the
        // first backup that starts. A pinned run asked for its model and keeps it.
        const startOnBackup = async () => {
          if (run.modelPinned) return undefined;
          for (const choice of await loadBackups()) {
            try {
              const backup = await resolveConnectedModelKey(
                deps,
                run,
                choice.provider,
                choice.modelId,
                (values) => runSecrets.push(...values),
                true,
                choice.credentialId,
              );
              getLogger().warn("model.primary_unavailable.backup_used", {
                runId,
                "model.provider": choice.provider,
                "model.id": choice.modelId,
              });
              return {
                provider: choice.provider,
                id: choice.modelId,
                credential: backup.credential,
                thinkingLevel: (choice.thinkingLevel ??
                  null) as AgentRunRequest["model"]["thinkingLevel"],
                resolved: backup.resolved,
              };
            } catch {
              // Resolver errors can carry credential details, so only the outcome is kept.
              backupsUnavailable.add(choice);
            }
          }
          return undefined;
        };
        let start: Awaited<ReturnType<typeof startOnBackup>>;
        let primaryFailure = { message: MISSING_MODEL_RUN_ERROR, accountFailure: true };
        let retryPrimary: unknown;
        if (selectedProvider && selectedModelId) {
          if (await modelAccessDenied()) {
            await failRunBeforeModel(MODEL_ACCESS_REQUIRED_RUN_ERROR, true);
            return;
          }
          try {
            start = {
              provider: selectedProvider,
              id: selectedModelId,
              credential: selected.credential,
              thinkingLevel: selected.thinkingLevel,
              resolved: await resolveModelKey(
                deps,
                run.userId,
                run.spaceId,
                selected.credential,
                selectedProvider,
                selectedModelId,
                (values) => runSecrets.push(...values),
              ),
            };
          } catch (error) {
            // An incompatible saved model or a dead (already retired) credential is a
            // configuration error: record it on the run rather than retrying setup.
            const terminal = isTerminalModelSetupError(error);
            if (!terminal && !isModelCredentialRejected(error)) throw error;
            primaryFailure = {
              message: error instanceof Error ? error.message : "Connect the provider again.",
              accountFailure:
                error instanceof HostedModelCreditsRequiredError ||
                isRetiredModelCredentialError(error),
            };
            if (!terminal) retryPrimary = error;
          }
        } else if (await modelAccessDenied()) {
          await failRunBeforeModel(MISSING_MODEL_RUN_ERROR, true);
          return;
        }
        start ??= await startOnBackup();
        if (!start) {
          if (retryPrimary) throw retryPrimary;
          await failRunBeforeModel(primaryFailure.message, primaryFailure.accountFailure);
          return;
        }
        const {
          provider: runModelProvider,
          id: runModelId,
          credential,
          thinkingLevel,
          resolved,
        } = start;
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
            computerUse.screenRelease = { computer, context, keepWarm: false };
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
          if (computerUse.reason === "none") {
            computerUse.reason = reason;
            computerUse.tool = tool && BUILTIN_AGENT_TOOL_NAMES.has(tool) ? tool : undefined;
          }
          return getLogger().withContext(
            {
              reason: computerUse.reason,
              tool: computerUse.tool,
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
        // Gate on the pair written to the run row above; re-deriving it would drop the
        // deployment fallback and gate a vision-capable default as text-only.
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
        const paymentWallet = deps.paymentWallet;
        const paymentWalletEnabled = paymentWallet
          ? await paymentWalletConnected(
              { prisma: deps.prisma, secretStore: deps.secretStore, paymentWallet },
              run.userId,
            )
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
            ({ resumeCheckpoint, heldForTakeover, takeoverResume } = refreshTakeoverContinuePlan(
              { resumeCheckpoint, heldForTakeover, takeoverResume },
              held,
            ));
          }
        }
        const sourceMessage =
          (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
            ? await deps.prisma.message.findUnique({
                where: { id: run.sourceMessageId },
                select: { clientNonce: true, role: true, blocks: true, threadId: true },
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
        const userComputerOwnerId = userComputerOwner({
          trigger: run.trigger,
          sourceRole: sourceMessage?.role,
          messagingChannelRun,
          runUserId: run.userId,
          botUserId: bot.userId,
        });
        let userComputer: UserComputerState;
        if (
          userComputerOwnerId &&
          deps.userDevices &&
          !disabledBuiltinTools.has(USER_COMPUTER_SHELL_TOOL)
        ) {
          if (await deps.userDevices.connected(userComputerOwnerId).catch(() => null))
            userComputer = "connected";
          // A chat that used the computer earlier may continue from another device after it closed.
          else if (await deps.userDevices.hasDevice(userComputerOwnerId).catch(() => false))
            userComputer = "offline";
        }
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
            paymentWalletEnabled,
            messagingChannelRun,
            voiceCall,
            disabledBuiltinTools: bot.disabledBuiltinTools,
            fleetManagement: bot.fleetManagement,
            followUpFromUser: sourceMessage?.role === "user",
            userComputer: userComputer === "connected",
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
        const trustLoaders = createRunTrustLoaders(deps, {
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
        let turnCheckpoint: string | undefined;
        let checkpointLoadError: Error | undefined;
        try {
          turnCheckpoint = await loadRunTurnCheckpoint(deps.prisma, run);
        } catch (error) {
          checkpointLoadError =
            error instanceof Error ? error : new Error("Unsupported turn checkpoint");
        }
        const storedTurnCheckpoint = Boolean(turnCheckpoint);
        const initiallyTainted =
          !ownerStartedRun || Boolean(turnCheckpoint) || Boolean(checkpointLoadError);
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

        const reply = await createReplyState(deps, run, runSecrets);
        const script = scripted ? inferScript(task.prompt, takeoverResume?.checkpoint) : undefined;
        const state: RunState = {
          lease,
          computerUse,
          runningHelpers,
          reply,
          approval: { pausePending: false, request: undefined, proposalInFlight: false },
          effects: {
            counts: new Map(),
            occurrences: [],
            restoredPending: undefined,
            consumedIds: new Set(),
            pendingTurnCheckpoints: new Map(),
            storedTurnCheckpoint,
          },
          screen: { lastFrameId: undefined, unchangedVisualStreak: { count: 0 } },
          toolCallStreak: { key: undefined, count: 0 },
          tainted: initiallyTainted,
          earlierAttempt: undefined,
          handedOff: false,
          terminalCheckpointComplete: false,
        };
        const { effects } = state;
        /** Fleet tools take every scope from the run, never from arguments. */
        const fleetRun: FleetRun = {
          spaceId: run.spaceId,
          userId: run.userId,
          botId: bot.id,
          groupId: thread.groupId ?? null,
          threadId: thread.id,
          runId,
        };

        const ctx: RunContext = {
          deps,
          providers: { web, mediaGeneration, browser, cloudAgent },
          run,
          runId,
          workerId,
          fence,
          attempt,
          bot,
          thread,
          task,
          context,
          abortController: runAbortController,
          fleetRun,
          secrets: runSecrets,
          source: {
            ownerStartedRun,
            messagingChannelRun,
            channelId,
            historySearchBeforeSeq,
            myChatsAllowed: historyMyChatsAllowed(
              run,
              sourceMessage,
              messagingChannelRun ||
                Boolean(
                  channelId ||
                    thread.externalConversationId ||
                    messagingChannelId(sourceMessage?.blocks as MessageBlock[] | undefined),
                ),
            ),
            voiceCall,
            callEndRun,
            callClientNonce: callClientNonceForRun,
            peerMessage,
            userComputerOwner: userComputerOwnerId,
          },
          computer: {
            stored: storedComputer,
            mode: computerMode,
            lease: computerLease,
            lazy: runComputer,
            get: getRunComputer,
            checkpoint: workspaceCheckpoint,
            hostEnvironment,
            graphical,
            graphicalToolsAllowed,
            pageBrowserAllowed,
            acceptsImages,
            heldForTakeover,
          },
          tools: {
            offered: tools,
            builtins,
            connector: connectorTools,
            disabled: disabledBuiltinTools,
            connectedPlugins,
            approvedReplays: approvedEffectReplays,
          },
          trust: { ...trustLoaders, searchResultUrls },
          memory: { semantic: semanticMemory, scope: memoryScope },
          scripted,
          script,
          allowSilentEmptyRun,
          emptyResponseText,
          state,
          settleRunningHelpers: settleHelpers,
          stopHeartbeatAfterCompletion,
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
          turnCheckpoint = restoreTurnCheckpointEffects(ctx, turnCheckpoint, {
            provider: runModelProvider,
            id: runModelId,
          });
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
                select: { id: true, name: true, description: true },
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
            !lease.valid || Boolean(runAbortController?.signal.aborted),
          )
        ) {
          return;
        }

        // The running model is not its own backup, unless another account serves it.
        const fallbackModels = (await loadBackups()).filter(
          (candidate) =>
            !backupsUnavailable.has(candidate) &&
            (candidate.provider !== runModelProvider ||
              candidate.modelId !== runModelId ||
              (candidate.credentialId !== undefined && candidate.credentialId !== credential?.id)),
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
                  !turnBlocks?.some(
                    (block) => block.kind === "image" && block.imageHandling === "confirm",
                  ),
              ),
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
                    resolveConnectedModel(run, provider, modelId, (values) =>
                      runSecrets.push(...values),
                    ),
              onToolCompleted: (completion) => {
                if (effects.restoredPending?.executionId === completion.executionId)
                  effects.restoredPending = undefined;
                if (!completion.paused)
                  effects.pendingTurnCheckpoints.delete(completion.executionId);
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
                  {
                    messageId: currentTurnMessage?.id,
                    hasImages: Boolean(currentTurnImages?.length),
                  },
                ),
            },
            context,
          );
          if (await consumeRunEvents(ctx, runtimeEvents)) return;
          if (await interruptedByShutdown()) return;
          await completeRun(ctx);
        } catch (caughtError) {
          if (await interruptedByShutdown()) return;
          await failRun(ctx, caughtError, {
            ownCredential: resolved.ownCredential,
            active: activeModel,
          });
        }
      } catch (setupError) {
        // An abort while stopping is not a setup failure, and must not spend the
        // retry budget that eventually fails the run.
        if (deps.shutdownSignal?.aborted) return;
        const computerBusy = setupError instanceof ComputerBusyError;
        const retryForever = computerBusy || isTooManyDatabaseConnections(setupError);
        const setupMessage = redactSecrets(userRunError(setupError), runSecrets);
        const reportedSetupError = sanitizedError(setupError, (text) =>
          redactSecrets(text, runSecrets),
        );
        // An outage at the computer provider is retried like any setup failure, but is not a
        // Rakazo bug to report.
        if (
          setupError instanceof SandboxUnavailableError ||
          setupError instanceof SandboxUnresponsiveError
        ) {
          getLogger().warn("run setup failed", { error: reportedSetupError });
        } else if (!computerBusy) {
          getLogger().error("run setup failed", reportedSetupError);
        }
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
          reason: computerUse.reason,
          tool: computerUse.tool,
          ready: Boolean(computerUse.screenRelease),
        });
        detachShutdown?.();
        clearInterval(heartbeat);
        if (!lease.retainComputer) {
          if (computerUse.screenRelease) {
            const releaseContext = computerUse.screenRelease.keepWarm
              ? { ...computerUse.screenRelease.context, keepScreenWarm: true }
              : computerUse.screenRelease.context;
            await deps.sandbox
              .releaseScreen?.(computerUse.screenRelease.computer, releaseContext)
              .catch(() => undefined);
          }
          await releaseComputerExecutionLease(deps.prisma, computerLease).catch(() => undefined);
          // A stopping process requeues this run instead, which must keep its turn.
          if (!deps.shutdownSignal?.aborted) {
            await startNextWaitingRun(deps, run.botId, runId).catch((error) =>
              getLogger().error("start next waiting run", error),
            );
          }
        }
        if (deps.shutdownSignal?.aborted) {
          // A renewal still in flight must not treat this release as a lost lease.
          lease.completed = true;
          await requeueRunAfterShutdown(deps, runId, workerId, fence).catch((error) =>
            getLogger().error("shutdown run requeue", error),
          );
        }
        await deps.prisma.attempt
          .updateMany({
            where: { id: attempt.id, status: "running" },
            data: { status: "interrupted", finishedAt: new Date() },
          })
          .catch(() => undefined);
        await settleHelpers();
      }
    },
  };
}
