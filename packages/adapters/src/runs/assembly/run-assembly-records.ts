import type { SemanticMemoryProvider } from "@rakazo/adapter-kit";
import { hasLab, resolveLabs } from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, isMessagingChannelRun, messagingChannelId } from "@rakazo/core";
import {
  effectiveMemoryScope,
  expireRunToolQuestions,
  loadRunHistoryMessages,
  loadRunTurnCheckpoint,
  readMessageBlocks,
  teamChatRunFromOwner,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { cloudAgentForActor } from "../../cloud-agents/cloud-agent-service.js";
import { screenLeaseIdForRun } from "../../computers/computer-lifecycle.js";
import {
  computerCheckpointResolver,
  isLostPinnedModel,
  PINNED_COMPUTER_MODEL_LOST_RUN_ERROR,
} from "../../computers/computer-model-settings.js";
import { formatAgentEnvironmentInstruction } from "../../computers/sandbox/agent-environment.prompt.js";
import {
  connectedContext,
  loadLivePlugins,
  persistLivePluginConnections,
  selectRunConnections,
} from "../../integrations/connection-context.js";
import { loadBotMessageContext } from "../../messaging/bot-messages.js";
import { resolveMemberMainModel } from "../../models/model-roles.js";
import {
  findConnectedModelCredential,
  runModelChoice,
  UNKNOWN_PROVIDER_MODEL,
} from "../../models/model-selection.js";
import { loadPurchaseRedactions } from "../../payments/purchase-service.js";
import {
  mergeConnectedPlugins,
  needsLivePluginSync,
} from "../../providers/integration/composio/composio-connector.js";
import { routineRunUsesOwnerComputer } from "../../routines/routine-owner-computer.js";
import { LEGACY_HISTORY_WINDOW_SIZE } from "../../runtime/context/history-compaction.js";
import { restoreComputerModels } from "../../runtime/pi/tools/pi-runtime-computer-mode.js";
import { toolActivationMode } from "../../runtime/pi/tools/pi-tool-activation.js";
import {
  loadCommandVariables,
  loadLoginPasswordRedactions,
  loadRunCodeRedactions,
  loadRunLoginRedactions,
} from "../../secrets/bot-secrets.js";
import { listAgentSkillRecords } from "../../tools/skill-tools.js";
import type { RunExecutorServices, RunHold } from "../lifecycle/run-attempt.js";
import { PausedTurnModelUnlistedError } from "../lifecycle/run-lifecycle.js";
import {
  isDelegatedRun,
  loadRunOrigin,
  RunOriginUnauthorizedError,
} from "../lifecycle/run-origin.js";
import { runReplaysToolHistory } from "../turn/tool-step-calls.js";
import { restoreTurnCheckpoint } from "../turn/turn-checkpoint.js";
import type { HistoryReach } from "./run-instructions.prompt.js";

export async function loadSavedTurn(services: RunExecutorServices, hold: RunHold) {
  const { resolveConnectedModel } = services;
  const { deps, run, secrets: runSecrets } = hold;
  // A saved computer turn owns both identities. Resolve them before consulting
  // today's main selection, whose connection may have changed while paused.
  let turnCheckpoint: string | undefined;
  let checkpointLoadError: Error | undefined;
  try {
    turnCheckpoint = await loadRunTurnCheckpoint(deps.prisma, run);
  } catch (error) {
    checkpointLoadError = error instanceof Error ? error : new Error("Unsupported turn checkpoint");
  }
  const storedTurnCheckpoint = Boolean(turnCheckpoint);
  const resolveCheckpointModel = (
    provider: string,
    id: string,
    connectionId?: string,
    effort?: string,
  ) =>
    resolveConnectedModel(
      run,
      provider,
      id,
      (values) => runSecrets.push(...values),
      true,
      effort ?? null,
      connectionId,
    );
  const checkpointIdentity = { provider: run.modelProvider ?? "", id: run.modelId ?? "" };
  const checkpointModelResolver = computerCheckpointResolver(
    turnCheckpoint,
    checkpointIdentity,
    resolveCheckpointModel,
  );
  const savedComputerMode = checkpointModelResolver
    ? restoreTurnCheckpoint(turnCheckpoint!, checkpointIdentity).computerMode
    : undefined;
  let pinnedComputerModels: Awaited<ReturnType<typeof restoreComputerModels>> | undefined;
  let pinnedComputerFailure: string | undefined;
  if (savedComputerMode) {
    try {
      pinnedComputerModels = await restoreComputerModels(
        { resolveFallbackModel: checkpointModelResolver },
        savedComputerMode,
      );
    } catch (error) {
      const unlisted = error instanceof Error && error.message === UNKNOWN_PROVIDER_MODEL;
      // A paused turn whose model or account is gone cannot resume; retrying will not help.
      if (isLostPinnedModel(error))
        pinnedComputerFailure = unlisted
          ? new PausedTurnModelUnlistedError().message
          : PINNED_COMPUTER_MODEL_LOST_RUN_ERROR;
      // A failed catalog read reports this too, so setup tries again before giving up.
      else if (unlisted) throw new PausedTurnModelUnlistedError();
      else throw error;
    }
  }
  return {
    turnCheckpoint,
    checkpointLoadError,
    storedTurnCheckpoint,
    resolveCheckpointModel,
    checkpointModelResolver,
    savedComputerMode,
    pinnedComputerModels,
    pinnedComputerFailure,
  };
}

export type SavedTurn = Awaited<ReturnType<typeof loadSavedTurn>>;

/** Messages a routine running alongside its chat reads: the chat's latest, as people saw them. */
export const ROUTINE_RECENT_MESSAGES = 10;
/** Replies of the routine's own earlier runs it also reads, so it can tell what is new. */
export const ROUTINE_EARLIER_RESULTS = 2;

/**
 * How much of the chat a run reads. A routine that runs in its chat reads all of it; one that runs
 * alongside reads its latest messages and its own earlier results. A creation intro and a check-in
 * read none.
 */
export function runHistoryReach(run: {
  trigger: string;
  routine?: { inChat: boolean } | null;
}): HistoryReach {
  if (run.trigger === "created") return "none";
  if (run.trigger !== "routine") return "all";
  if (!run.routine) return "none";
  return run.routine.inChat ? "all" : "recent";
}

export async function loadRunRecords(
  services: RunExecutorServices,
  hold: RunHold,
  parts: { saved: SavedTurn },
) {
  const { contextStrategy } = services;
  const { deps, run, secrets: runSecrets } = hold;
  const { pinnedComputerModels } = parts.saved;
  const origin = await loadRunOrigin(deps.prisma, run);
  if (isDelegatedRun(run.trigger) && run.delegatedFromRunId && !origin)
    throw new RunOriginUnauthorizedError();
  const conversationRun = origin ?? run;
  const messagingSource =
    conversationRun.trigger === "messaging" && conversationRun.sourceMessageId
      ? await deps.prisma.message.findUnique({
          where: { id: conversationRun.sourceMessageId },
          select: { id: true, blocks: true, clientNonce: true },
        })
      : null;
  const source = messagingSource ? readMessageBlocks(messagingSource) : undefined;
  const sourceBlocks = source?.blocks;
  const channelId = messagingChannelId(sourceBlocks);
  // A source that lost entries may have lost its channel marker: the run gets a channel's
  // limits, and its reply is not sent to a chat app (see MessagingDelivery.deliverRun).
  const messagingChannelRun =
    isMessagingChannelRun(conversationRun.trigger, sourceBlocks) || source?.intact === false;
  // Without the marker nothing says which of the thread's messages that channel may see,
  // so the run reads only the message that woke it and gets no history tools.
  const unknownChannelSourceId =
    messagingChannelRun && !channelId ? messagingSource?.id : undefined;
  // A routine the owner let use their computer reads only its own prompt.
  const ownerComputerRoutine = await routineRunUsesOwnerComputer(deps.prisma, run);
  const historyReach = ownerComputerRoutine ? "none" : runHistoryReach(run);
  const [
    { bot, ownerLabs },
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
    { env: initialBotCommandEnvironment, redactions: commandRedactions },
    savedLoginPasswordRedactions,
    purchaseRedactions,
    runLoginRedactions,
    runCodeRedactions,
  ] = await Promise.all([
    deps.prisma.bot
      .findUniqueOrThrow({
        where: { id: run.botId },
        include: { computer: true },
      })
      .then(async (bot) => ({
        bot,
        ownerLabs: (
          await deps.prisma.user.findUnique({
            where: { id: bot.userId },
            select: { labs: true },
          })
        )?.labs,
      })),
    deps.prisma.thread.findUniqueOrThrow({
      where: { id: run.threadId },
      include: {
        space: { select: { _count: { select: { memberships: true } } } },
      },
    }),
    loadRunHistoryMessages(
      deps.prisma,
      run,
      ownerComputerRoutine
        ? 0
        : historyReach === "recent"
          ? ROUTINE_RECENT_MESSAGES
          : LEGACY_HISTORY_WINDOW_SIZE,
      run.trigger === BACKGROUND_HELPER_TRIGGER
        ? undefined
        : channelId
          ? { channelId }
          : unknownChannelSourceId
            ? { sourceMessageId: unknownChannelSourceId }
            : undefined,
      run.trigger === "routine" && run.routineId
        ? {
            routineId: run.routineId,
            earlierResults: historyReach === "recent" ? ROUTINE_EARLIER_RESULTS : 0,
          }
        : undefined,
      // A webhook run answers the delivery that started it (or the last of its batch), not a
      // newer one that arrived while it waited on an approval.
      run.trigger === "webhook" && run.sourceMessageId
        ? { sourceMessageId: run.sourceMessageId }
        : undefined,
    ),
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
        updatedAt: true,
      },
    }),
    pinnedComputerModels ? Promise.resolve(null) : resolveMemberMainModel(deps, run),
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
    loadCommandVariables(deps.prisma, deps.secretStore, run),
    loadLoginPasswordRedactions(deps.prisma, deps.secretStore, run),
    deps.paymentWallet ? loadPurchaseRedactions(deps, run) : [],
    loadRunLoginRedactions(deps.prisma, deps.secretStore, run, run.id),
    loadRunCodeRedactions(deps.prisma, deps.secretStore, run, run.id),
  ]);
  // Team chat reaches people besides the owner, so their runs get a group channel's limits.
  const conversationThread = origin?.thread ?? thread;
  const teamChatConversationId =
    conversationRun.trigger === "messaging" ? conversationThread.externalConversationId : null;
  const nonOwnerChatRun =
    (isDelegatedRun(run.trigger) && !origin) ||
    messagingChannelRun ||
    (teamChatConversationId
      ? !(await teamChatRunFromOwner(deps.prisma, {
          externalConversationId: teamChatConversationId,
          sourceClientNonce: messagingSource?.clientNonce,
        }))
      : false);
  const replaysToolHistory = runReplaysToolHistory(run.trigger, {
    fromUser: messages.find((message) => message.id === run.sourceMessageId)?.role === "user",
    nonOwnerChat: nonOwnerChatRun,
  });
  const ticketBoardEnabled = hasLab(resolveLabs(ownerLabs, deps.deploymentLabs), "board");
  const historySearchBeforeSeq =
    contextStrategy !== "current" && conversationRun.sourceMessageId
      ? (messages.find((message) => message.id === conversationRun.sourceMessageId)?.seq ??
        (
          await deps.prisma.message.findUnique({
            where: { id: conversationRun.sourceMessageId, threadId: conversationThread.id },
            select: { seq: true },
          })
        )?.seq ??
        conversationThread.nextMessageSeq)
      : conversationThread.nextMessageSeq;
  // Encoded forms too: read_file redacts with these values before any shell command runs.
  // Read here only to hide the values and to tell the model the variables' names: no
  // command has them yet, so nothing is recorded as used until the shell tool sends one.
  runSecrets.push(...commandRedactions);
  // A login filled in an earlier run may still be on its page, and anything this run reads
  // or is given may contain it, so every run hides its saved passwords before the model runs.
  runSecrets.push(
    ...savedLoginPasswordRedactions,
    ...purchaseRedactions,
    ...runLoginRedactions,
    ...runCodeRedactions,
  );
  const agentEnvironmentInstruction = formatAgentEnvironmentInstruction(
    initialBotCommandEnvironment,
  );
  // modelPinned distinguishes the captured choice from an attempt's recorded model.
  const modelChoice = runModelChoice(run, bot);
  const hasModelOverride = Boolean(modelChoice.modelProvider && modelChoice.modelId);
  const overrideCredential =
    !pinnedComputerModels && hasModelOverride && modelChoice.modelProvider
      ? await findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          run,
          modelChoice.modelProvider,
          modelChoice.modelId,
        )
      : null;
  return {
    historyReach,
    ownerComputerRoutine,
    origin,
    conversationRun,
    conversationThread,
    sourceBlocks,
    channelId,
    messagingChannelRun,
    unknownChannelSourceId,
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
    nonOwnerChatRun,
    replaysToolHistory,
    ticketBoardEnabled,
    historySearchBeforeSeq,
    agentEnvironmentInstruction,
    modelChoice,
    overrideCredential,
  };
}

export type RunRecords = Awaited<ReturnType<typeof loadRunRecords>>;

export async function connectRun(
  services: RunExecutorServices,
  hold: RunHold,
  parts: { records: RunRecords },
) {
  const { executorDeps } = services;
  const { deps, run, runId, fence, computerLease, lease } = hold;
  const { bot, configuredMemory, storedConnections, thread } = parts.records;
  const runAbortController = new AbortController();
  hold.abort.controller = runAbortController;
  if (!lease.valid) runAbortController.abort();
  if (deps.shutdownSignal?.aborted) runAbortController.abort(deps.shutdownSignal.reason);
  const onShutdown = () => runAbortController?.abort(deps.shutdownSignal?.reason);
  deps.shutdownSignal?.addEventListener("abort", onShutdown);
  hold.detachShutdown = () => deps.shutdownSignal?.removeEventListener("abort", onShutdown);
  const composioRows = storedConnections.filter(
    (connection) => connection.connectorId === "composio",
  );
  let liveSlugs: string[] = [];
  if (needsLivePluginSync(composioRows)) {
    const listing = await loadLivePlugins(deps.listConnectedPlugins, run.userId);
    if (listing.ok) {
      liveSlugs = listing.slugs;
      await bestEffort(
        "save live plugin connections",
        persistLivePluginConnections(deps.prisma, run, composioRows, listing),
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
  const toolActivation = toolActivationMode();

  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "run.started",
    runId,
    payload: {
      trigger: run.trigger,
      // Whose cards a viewer may answer while the run runs, before the next snapshot.
      userId: run.userId,
      routineId: run.routineId,
      ...(run.routine ? { routineName: run.routine.name } : {}),
      ...(toolActivation === "direct" ? { toolActivation } : {}),
    },
  });

  // A question a tool asked in an earlier attempt lost its call with that attempt's process.
  await bestEffort(
    "tool questions",
    expireRunToolQuestions(deps.prisma, { id: runId, spaceId: run.spaceId }, (threadId, seq) =>
      deps.events.notify(threadId, seq),
    ),
  );

  const discoveredPromise = deps.connector
    ? deps.connector.discoverTools(context)
    : Promise.resolve([]);
  // Awaited steps later: if one before it throws, a rejection here would stop the process.
  void bestEffort("tool discovery", discoveredPromise);
  // A connection that cannot be read now leaves the cloud-agent tools out of this turn only.
  const cloudAgentPromise = cloudAgentForActor(executorDeps, {
    spaceId: run.spaceId,
    userId: run.userId,
    botIds: [bot.id],
  }).catch(() => null);
  return {
    runAbortController,
    connectedPlugins,
    context,
    memoryScope,
    semanticMemory,
    discoveredPromise,
    cloudAgentPromise,
    toolActivation,
  };
}

export type ConnectedRun = Awaited<ReturnType<typeof connectRun>>;
