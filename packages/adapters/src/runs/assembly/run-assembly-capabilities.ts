import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { disabledBuiltinToolSet } from "@rakazo/contracts";
import {
  BACKGROUND_HELPER_TRIGGER,
  chatAppConnectNote,
  HELPER_RESULT_TRIGGER,
  isCallClientNonce,
  isOwnerStartedRun,
  messagingChannelPrivacyBlock,
  messagingDmSurfaceNote,
  nonOwnerChatPrivacyBlock,
} from "@rakazo/core";
import { mayBeChannelMessage, parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createApprovedEffectReplayQueue } from "../../approvals/approval-effect.js";
import { appendOutsideText, taskPromptIsOutside } from "../../approvals/review-target-sources.js";
import { loadGroupContext } from "../../bots/group-handoff.js";
import { USER_CLOUD_AGENT_KEY_PREFIX } from "../../cloud-agents/cloud-agent-factory.js";
import { diskNoteInstruction, recordComputerDisk } from "../../computers/computer-disk.js";
import { scheduleComputerSleep } from "../../computers/computer-idle.js";
import {
  provisionComputer,
  screenLeaseIdForRun,
  waitForRunComputerLease,
} from "../../computers/computer-lifecycle.js";
import { resolveComputerRunModel } from "../../computers/computer-model-settings.js";
import { checkpointRunComputerWorkspace } from "../../computers/computer-workspace.js";
import { sandboxKindCapabilities } from "../../computers/sandbox/sandbox-kind-capabilities.js";
import { teamWorkspaceInstruction } from "../../computers/screens/computer-support.prompt.js";
import type { RunMediaSources } from "../../media/media-sources.js";
import { approvedModelCreditOffering } from "../../model-credits/offerings.js";
import { resolveDeploymentModel } from "../../models/deployment-model.js";
import { selectConfiguredModel } from "../../models/model-roles.js";
import {
  findConnectedModelCredential,
  PINNED_PROVIDER_NOT_CONNECTED,
  pinnedModelCredentialError,
} from "../../models/model-selection.js";
import { modelAcceptsImageInput } from "../../models/model-vision.js";
import { paymentWalletConnected } from "../../payments/payment-wallets.js";
import { backOffRoutineAfterAccountError } from "../../routines/routine-backoff.js";
import { pauseRoutineAfterRepeatedFailures } from "../../routines/routine-failure-pause.js";
import { filterStrategicInitiativeTools } from "../../routines/strategic-initiative.js";
import {
  createEarlierFileQueue,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeEarlierFiles,
  materializeRecentThreadFiles,
} from "../../storage/thread-artifacts.js";
import {
  currentTurnFilesInstruction,
  recentThreadFilesInstruction,
} from "../../storage/thread-artifacts.prompt.js";
import { backgroundHelpersAllowed } from "../../tasks/background-helpers.js";
import { TASK_CATALOG_GUIDANCE } from "../../tasks/task-catalog.prompt.js";
import { agentConnectionTools, builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import type { RunExecutorServices, RunHold } from "../lifecycle/run-attempt.js";
import { APPROVED_EFFECT_REPLAY_ORDER } from "../lifecycle/run-effects.js";
import { createRunWorkspaceCheckpoint, failRunBeforeTurn } from "../lifecycle/run-lifecycle.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  offersAgentConnectionTools,
  selectBuiltinToolsForRun,
  unavailableBuiltinToolReasons,
} from "../tools/run-tool-selection.js";
import { historyMyChatsAllowed } from "../tools/run-tools-memory.js";
import type { UserComputerState } from "../tools/run-tools-user-computer.js";
import { USER_COMPUTER_SHELL_TOOL, userComputerOwner } from "../tools/run-tools-user-computer.js";
import {
  modelCreditBillingEnabled,
  resolvedModelRunFields,
  runtimeFallbackModel,
} from "../turn/run-model.js";
import { runModelBackups, startRunModel } from "../turn/run-model-start.js";
import { RECENT_TURN_IMAGE_TURNS } from "../turn/run-turn-images.js";
import { refreshTakeoverContinuePlan } from "../turn/takeover-resume.js";
import { historyReplaysOutsideContent, historyToolResults } from "../turn/tool-step-calls.js";
import type { ThreadHistory, TurnContext } from "./run-assembly-history.js";
import type { ConnectedRun, RunRecords, SavedTurn } from "./run-assembly-records.js";
import { lazyRunComputer } from "./run-computer.js";
import {
  BOT_DIRECTORY_LIMIT,
  COMPUTER_USE_INSTRUCTION,
  dockerComputerToolInstruction,
  hostComputerInstruction,
  PRIVATE_WORKSPACE_INSTRUCTION,
  persistentComputerInstruction,
} from "./run-instructions.prompt.js";
import { runReplyMode } from "./run-replies.prompt.js";
import { createRunTrustLoaders } from "./run-trust.js";

/** Undefined when the run cannot start its model: it was failed instead of starting a turn. */
export async function startTurnModel(
  hold: RunHold,
  parts: { saved: SavedTurn; records: RunRecords },
) {
  const { deps, run, runId, workerId, fence, attempt, secrets: runSecrets } = hold;
  const { pinnedComputerFailure, pinnedComputerModels } = parts.saved;
  const { bot, main, modelChoice, overrideCredential, settings } = parts.records;
  const runDeployment = deps.deploymentModelConfigured ? resolveDeploymentModel() : null;
  const runtimeFallback = runtimeFallbackModel(deps.runtime);
  const pinError =
    !pinnedComputerModels &&
    run.modelPinned &&
    !(
      (await modelCreditBillingEnabled(deps)) &&
      (modelChoice.modelProvider === runDeployment?.provider ||
        (modelChoice.modelProvider &&
          modelChoice.modelId &&
          approvedModelCreditOffering(modelChoice.modelProvider, modelChoice.modelId)))
    )
      ? pinnedModelCredentialError(modelChoice, overrideCredential)
      : undefined;
  const selected = pinnedComputerModels
    ? {
        provider: pinnedComputerModels.main.provider,
        id: pinnedComputerModels.main.id,
        thinkingLevel: pinnedComputerModels.main.thinkingLevel,
        credential: null,
        connectionId: pinnedComputerModels.main.connectionId,
      }
    : selectConfiguredModel({
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
    if (failed && run.trigger === "routine" && run.routineId) {
      const ref = { routineId: run.routineId, userId: run.userId };
      if (accountFailure) await backOffRoutineAfterAccountError(deps, ref);
      // The model setup the user chose cannot start, which only they can change.
      await pauseRoutineAfterRepeatedFailures(deps, {
        ...ref,
        spaceId: run.spaceId,
        botId: run.botId,
      });
    }
  };
  if (pinnedComputerFailure) {
    await failRunBeforeModel(pinnedComputerFailure, true);
    return;
  }
  if (pinError) {
    await failRunBeforeModel(pinError, pinError === PINNED_PROVIDER_NOT_CONNECTED);
    return;
  }
  if (
    !pinnedComputerModels &&
    run.modelPinned &&
    (selected.provider !== modelChoice.modelProvider || selected.id !== modelChoice.modelId)
  ) {
    await failRunBeforeModel(PINNED_PROVIDER_NOT_CONNECTED, true);
    return;
  }
  const scripted = deps.runtime.describe().capabilities.scripted;
  const registerRunSecrets = (values: string[]) => runSecrets.push(...values);
  const backups = runModelBackups(
    deps,
    run,
    { settings, deployment: runDeployment },
    scripted,
    registerRunSecrets,
  );
  const started = await startRunModel(
    deps,
    run,
    {
      provider: selectedProvider,
      id: selectedModelId,
      credential: selected.credential,
      connectionId: selected.connectionId,
      adminSettings: settings,
      thinkingLevel: selected.thinkingLevel,
    },
    pinnedComputerModels?.main,
    backups,
    registerRunSecrets,
  );
  if (started.failure) {
    await failRunBeforeModel(started.failure.message, started.failure.accountFailure);
    return;
  }
  const {
    provider: runModelProvider,
    id: runModelId,
    credential,
    thinkingLevel,
    resolved,
  } = started.start;
  runSecrets.push(...resolved.redact);
  // A pin stays as it was created. Unpinned runs still record the model they
  // used; modelPinned is what keeps that record from becoming the next choice.
  if (!run.modelPinned) {
    await deps.prisma.run.updateMany({
      where: { id: runId, status: "running", leaseOwner: workerId, leaseFence: fence },
      data: { modelProvider: runModelProvider, modelId: runModelId },
    });
  }
  return { scripted, backups, runModelProvider, runModelId, credential, thinkingLevel, resolved };
}

export type StartedTurnModel = NonNullable<Awaited<ReturnType<typeof startTurnModel>>>;

export async function prepareRunComputer(
  hold: RunHold,
  parts: {
    records: RunRecords;
    connected: ConnectedRun;
    turnContext: TurnContext;
    model: StartedTurnModel;
  },
) {
  const { deps, run, runId, computerUse } = hold;
  const { bot } = parts.records;
  const { context, runAbortController } = parts.connected;
  const { currentTurnMessage, history, historyMessages, turnBlocks } = parts.turnContext;
  const { resolved, runModelId, runModelProvider } = parts.model;
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
  // Files from earlier messages that history tools surfaced this run.
  const earlierFiles = createEarlierFileQueue();
  const runComputer = lazyRunComputer(
    async () => {
      if (!hold.computerLease) {
        hold.computerLease = await waitForRunComputerLease(
          deps.prisma,
          {
            computerId: storedComputer.id,
            botId: bot.id,
            runId,
            workerId: hold.workerId,
            runFence: hold.fence,
          },
          context.signal,
        );
        context.screenLeaseId = screenLeaseIdForRun(hold.computerLease, runId, hold.fence);
      }
      getLogger().info("computer.requested");
      const computer = await provisionComputer(deps, storedComputer.id, context, "bot");
      earlierFiles.computerStarted();
      computerUse.screenRelease = { computer, context, keepWarm: false };
      recordComputerDisk(deps, storedComputer.id, computer, context);
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
  const computerKind =
    (await deps.sandbox.provisionKind?.(storedComputer.homeKey)) ?? storedComputer.kind;
  const workspaceCheckpoint = createRunWorkspaceCheckpoint(
    async () => {
      if (!runComputer.ready) return;
      await checkpointRunComputerWorkspace(deps, storedComputer, runComputer.ready, context);
    },
    { id: storedComputer.id, kind: computerKind },
    context.signal,
  );
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
            const earlier = earlierFiles.take();
            if (artifacts && earlier.length) {
              earlierFiles.copiedTo(
                earlier,
                // Saved with the run's checkpoint, so a resumed attempt still has them.
                await materializeEarlierFiles({ ...deps, artifacts }, earlier, {
                  context,
                  computer: async () => computer,
                  computerMode,
                  markWorkspaceDirty: workspaceCheckpoint.markDirty,
                }),
              );
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
    !sandboxKindCapabilities(computerKind).runsOnUserMachine &&
    deps.sandbox.describe().capabilities.graphical;
  // Gate on the pair written to the run row above; re-deriving it would drop the
  // deployment fallback and gate a vision-capable default as text-only.
  const modelSeesImages = modelAcceptsImageInput(
    runModelProvider,
    runModelId,
    resolved.acceptsImages,
  );
  return {
    storedComputer,
    computerMode,
    earlierFiles,
    runComputer,
    computerKind,
    workspaceCheckpoint,
    pendingTurnFiles,
    getRunComputer,
    currentTurnFiles,
    attachedFilesPrompt,
    graphical,
    modelSeesImages,
  };
}

export type PreparedRunComputer = Awaited<ReturnType<typeof prepareRunComputer>>;

export async function resolveRunCapabilities(
  services: RunExecutorServices,
  hold: RunHold,
  parts: {
    saved: SavedTurn;
    records: RunRecords;
    connected: ConnectedRun;
    thread: ThreadHistory;
    model: StartedTurnModel;
    computer: PreparedRunComputer;
  },
) {
  const { browser } = services;
  const { deps, run, runId } = hold;
  const {
    checkpointModelResolver,
    pinnedComputerModels,
    resolveCheckpointModel,
    storedTurnCheckpoint,
  } = parts.saved;
  const { bot, messagingChannelRun, nonOwnerChatRun, conversationRun, conversationThread, origin } =
    parts.records;
  const { cloudAgentPromise } = parts.connected;
  const { people } = parts.thread;
  const { credential, resolved, runModelId, runModelProvider, scripted, thinkingLevel } =
    parts.model;
  const { graphical, modelSeesImages } = parts.computer;
  const groupContext = conversationThread.groupId
    ? await loadGroupContext(
        deps.prisma,
        conversationThread.groupId,
        { id: bot.id, name: bot.name },
        Boolean(people),
      )
    : undefined;
  const hasMessagingIdentity = deps.messaging ? await deps.messaging.hasIdentity(bot.id) : false;
  const paymentWallet = deps.paymentWallet;
  const paymentWalletEnabled = paymentWallet
    ? await paymentWalletConnected(
        {
          prisma: deps.prisma,
          secretStore: deps.secretStore,
          jobs: deps.jobs,
          paymentWallet,
        },
        run.userId,
      )
    : false;
  // Only a turn in the app can carry a request to connect one.
  const chatApps =
    ["user", "follow_up"].includes(conversationRun.trigger) &&
    !messagingChannelRun &&
    !nonOwnerChatRun
      ? [...new Set(deps.messaging?.chatApps?.() ?? [])]
      : [];
  const messagingContext =
    [
      hasMessagingIdentity ? messagingDmSurfaceNote() : null,
      chatApps.length > 0
        ? chatAppConnectNote(chatApps, !bot.disabledBuiltinTools?.includes("connect_app"))
        : null,
      messagingChannelRun
        ? messagingChannelPrivacyBlock()
        : nonOwnerChatRun
          ? nonOwnerChatPrivacyBlock()
          : null,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined;
  if (hold.takeover.heldForTakeover) {
    const held = await deps.prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, checkpoint: true },
    });
    if (held) {
      hold.takeover = refreshTakeoverContinuePlan(hold.takeover, held);
    }
  }
  const { heldForTakeover } = hold.takeover;
  const mainRunModel: AgentRunRequest["model"] = pinnedComputerModels?.main ?? {
    provider: runModelProvider,
    id: runModelId,
    ...(credential ? { connectionId: credential.id } : {}),
    ...resolvedModelRunFields(resolved, thinkingLevel),
  };
  // Saved identities win on resume, including when the setting was cleared meanwhile.
  const computerModel =
    pinnedComputerModels?.computer ??
    // A paused turn resumes with the models it started with, even one saved before this setting.
    (scripted || storedTurnCheckpoint || !graphical
      ? undefined
      : await resolveComputerRunModel(
          {
            prisma: deps.prisma,
            resolve: resolveCheckpointModel,
            connectionFor: async (provider, modelId) =>
              (
                await findConnectedModelCredential(
                  deps.prisma,
                  deps.secretStore,
                  run,
                  provider,
                  modelId,
                )
              )?.id,
          },
          { userId: run.userId, spaceId: run.spaceId },
          mainRunModel,
        ));
  const sourceMessage =
    (run.trigger === "user" || run.trigger === "follow_up") && run.sourceMessageId
      ? await deps.prisma.message.findUnique({
          where: { id: run.sourceMessageId },
          select: {
            id: true,
            clientNonce: true,
            role: true,
            blocks: true,
            threadId: true,
          },
        })
      : null;
  // Calls carry no schema flag: the sending client encodes them in the clientNonce.
  const sourceClientNonce = sourceMessage?.clientNonce ?? null;
  // A follow-up can be queued by a bot (group handoffs); only the user's own counts.
  const ownerStartedRun = isOwnerStartedRun(
    conversationRun.trigger,
    (origin?.sourceMessage ?? sourceMessage)?.role === "user",
    nonOwnerChatRun,
  );
  // A hang-up run has no source message: its own nonce carries the call it closes.
  const callEndRun = run.trigger === "call_end";
  const callClientNonceForRun = callEndRun ? run.clientNonce : sourceClientNonce;
  const voiceCall = callEndRun || isCallClientNonce(sourceClientNonce);
  const acceptsImages =
    deps.runtime.describe().capabilities.scripted ||
    modelSeesImages ||
    Boolean(computerModel || checkpointModelResolver);
  const graphicalToolsAllowed = graphical && acceptsImages && !heldForTakeover;
  const pageBrowserAllowed = graphical && browser.describe().capabilities.page && !heldForTakeover;
  const disabledBuiltinTools = disabledBuiltinToolSet(bot.disabledBuiltinTools);
  const replyMode = runReplyMode(run.trigger, bot.replyMode, disabledBuiltinTools);
  const emailName = deps.inboundEmailDomain
    ? await deps.prisma.botEmailAddress.findUnique({
        where: { botId: bot.id },
        select: { name: true },
      })
    : null;
  const botEmail = emailName ? `${emailName.name}@${deps.inboundEmailDomain}` : null;
  // The inbox is the owner's mail: read only in their own runs, never in a group or channel, and
  // never for another bot, which may be answering someone else.
  const emailInbox =
    Boolean(botEmail) &&
    run.userId === bot.userId &&
    run.trigger !== "bot_message" &&
    !conversationThread.groupId &&
    !nonOwnerChatRun;
  const userComputerOwnerId = userComputerOwner({
    trigger: conversationRun.trigger,
    sourceRole: (origin?.sourceMessage ?? sourceMessage)?.role,
    messagingChannelRun: nonOwnerChatRun,
    runUserId: run.userId,
    botUserId: bot.userId,
    ownerComputerRoutine: parts.records.ownerComputerRoutine,
  });
  let userComputer: UserComputerState;
  let userComputerShell = false;
  let userComputerScreen = false;
  if (
    userComputerOwnerId &&
    deps.userDevices &&
    !disabledBuiltinTools.has(USER_COMPUTER_SHELL_TOOL)
  ) {
    const device = await deps.userDevices.connected(userComputerOwnerId).catch(() => null);
    if (device) {
      userComputer = "connected";
      userComputerShell = !device.screenOnly;
      // The macOS and Windows desktops fetch a screen driver; Linux has none yet.
      const computers = await deps.userDevices.list(userComputerOwnerId);
      userComputerScreen = [device, ...computers.filter((computer) => computer.connected)].some(
        (computer) => computer.platform === "darwin" || computer.platform === "win32",
      );
    } else userComputer = "offline";
  }
  const cloudAgent = await cloudAgentPromise;
  // Revocation blocks new instructions, but existing owned agents still need cleanup.
  const cloudAgentCleanupEnabled = Boolean(
    !cloudAgent &&
      deps.userCloudAgents &&
      (await deps.prisma.cloudAgent
        .findFirst({
          where: {
            spaceId: run.spaceId,
            userId: run.userId,
            providerKey: { startsWith: USER_CLOUD_AGENT_KEY_PREFIX },
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          getLogger().warn("cloud_agent.cleanup_lookup_failed", { error });
          return null;
        })),
  );
  return {
    groupContext,
    hasMessagingIdentity,
    paymentWalletEnabled,
    messagingContext,
    mainRunModel,
    computerModel,
    sourceMessage,
    ownerStartedRun,
    callEndRun,
    callClientNonceForRun,
    voiceCall,
    acceptsImages,
    graphicalToolsAllowed,
    pageBrowserAllowed,
    disabledBuiltinTools,
    replyMode,
    emailName,
    botEmail,
    emailInbox,
    userComputerOwnerId,
    userComputer,
    userComputerShell,
    userComputerScreen,
    cloudAgent,
    cloudAgentCleanupEnabled,
  };
}

export type RunCapabilities = Awaited<ReturnType<typeof resolveRunCapabilities>>;

export async function selectRunTools(
  services: RunExecutorServices,
  hold: RunHold,
  parts: {
    saved: SavedTurn;
    records: RunRecords;
    connected: ConnectedRun;
    turnContext: TurnContext;
    capabilities: RunCapabilities;
    meetingTranscriptsAvailable?: boolean;
    media: RunMediaSources;
  },
) {
  const { contextStrategy, paidServices } = services;
  const { deps, run, runId } = hold;
  const { checkpointLoadError, turnCheckpoint } = parts.saved;
  const {
    bot,
    channelId,
    conversationRun,
    nonOwnerChatRun,
    sourceBlocks,
    task,
    conversationThread,
    ticketBoardEnabled,
    unknownChannelSourceId,
    ownerComputerRoutine,
  } = parts.records;
  const { connectedPlugins, semanticMemory } = parts.connected;
  const { discovered, groupReplyOptional, history, semanticMemoryEnabled } = parts.turnContext;
  const {
    cloudAgent,
    cloudAgentCleanupEnabled,
    disabledBuiltinTools,
    emailInbox,
    emailName,
    graphicalToolsAllowed,
    hasMessagingIdentity,
    ownerStartedRun,
    pageBrowserAllowed,
    paymentWalletEnabled,
    sourceMessage,
    userComputerScreen,
    userComputerShell,
    voiceCall,
  } = parts.capabilities;
  const myChatsAllowed = historyMyChatsAllowed(
    conversationRun,
    parts.records.origin?.sourceMessage ?? sourceMessage,
    nonOwnerChatRun ||
      Boolean(
        channelId ||
          conversationThread.externalConversationId ||
          (sourceMessage && mayBeChannelMessage(sourceMessage)),
      ),
  );
  // In a group the members are the room's; a bot elsewhere messages the Space's other bots. A
  // routine with its owner's computer messages none, nor reads their names and descriptions.
  const teammates =
    conversationThread.groupId || ownerComputerRoutine
      ? []
      : await deps.prisma.bot.findMany({
          where: {
            spaceId: run.spaceId,
            archivedAt: null,
            id: { not: bot.id },
            thread: { isNot: null },
          },
          select: { id: true, name: true, description: true },
          orderBy: { createdAt: "asc" },
          take: BOT_DIRECTORY_LIMIT,
        });
  // Another group the bot belongs to, which post_to_group can post into.
  const otherGroups = await deps.prisma.chatGroup.findMany({
    where: {
      spaceId: run.spaceId,
      archivedAt: null,
      thread: { isNot: null },
      members: { some: { botId: bot.id } },
      ...(conversationThread.groupId ? { id: { not: conversationThread.groupId } } : {}),
    },
    select: { id: true },
    take: 1,
  });
  const builtins = [
    ...selectBuiltinToolsForRun({
      ticketBoardEnabled,
      // A call rings the bot's own person in its own app chat, and only once they set up a voice
      // provider; other members of a shared Space reach it by message for now.
      phoneCallsEnabled:
        deps.phoneCallsEnabled &&
        run.userId === bot.userId &&
        !conversationThread.externalConversationId &&
        Boolean(
          await deps.prisma.userVoiceCredential.findFirst({
            where: { userId: run.userId },
            select: { id: true },
          }),
        ),
      historyRetrievalEnabled: contextStrategy !== "current" && !unknownChannelSourceId,
      historyMyChats: myChatsAllowed,
      ownPromptOnly: ownerComputerRoutine,
      meetingTranscriptsAvailable: parts.meetingTranscriptsAvailable,
      graphicalToolsAllowed,
      pageBrowserAllowed,
      groupId: conversationThread.groupId,
      trigger: run.trigger,
      semanticMemoryEnabled,
      semanticMemoryForgets: Boolean(semanticMemory?.forget),
      semanticMemoryReflects: Boolean(semanticMemory?.reflect),
      mediaImagesEnabled: Boolean(deps.artifacts && parts.media.image),
      mediaVideoEnabled: Boolean(deps.artifacts && parts.media.video),
      paidServicesEnabled: Boolean(paidServices),
      cloudAgentEnabled: Boolean(cloudAgent),
      cloudAgentCleanupEnabled,
      paymentWalletEnabled,
      messagingChannelRun: nonOwnerChatRun,
      voiceCall,
      // Every member already got a message that names nobody, so a handoff only repeats it.
      disabledBuiltinTools: groupReplyOptional
        ? [...(bot.disabledBuiltinTools ?? []), "handoff_to_bot"]
        : bot.disabledBuiltinTools,
      fleetManagement: bot.fleetManagement,
      hasTeammates: teammates.length > 0,
      hasGroups: otherGroups.length > 0,
      followUpFromUser: sourceMessage?.role === "user",
      userComputer: userComputerShell,
      userComputerScreen,
      emailInbox,
      emailClaimable: Boolean(deps.inboundEmailDomain) && !emailName && run.userId === bot.userId,
      emailSend: Boolean(deps.email),
    }).filter(
      (tool) => tool.name !== "run_subagent" || backgroundHelpersAllowed({ trigger: run.trigger }),
    ),
    // Cross-owner agent connections only exist for chat-linked bots. The chat link is its
    // creator's, and a connected agent's messages run as them, so only their runs may
    // open, approve or use one.
    ...(run.userId === bot.userId &&
    !ownerComputerRoutine &&
    offersAgentConnectionTools({
      hasMessagingIdentity,
      crossSpaceCommunication: bot.crossSpaceCommunication === true,
      trigger: run.trigger,
    })
      ? agentConnectionTools.filter((tool) => !disabledBuiltinTools.has(tool.name))
      : []),
  ];
  const strategicBuiltins = filterStrategicInitiativeTools(builtins, {
    trigger: run.trigger,
    clientNonce: run.clientNonce,
  });
  // Connector and MCP results are other services' text, which a routine with its owner's computer
  // never reads (see selectBuiltinToolsForRun's ownPromptOnly).
  const exposedConnectorTools = ownerComputerRoutine
    ? []
    : discovered.filter((tool) => !builtinAgentTools.some((builtin) => builtin.name === tool.name));
  const strategicConnectorTools = filterStrategicInitiativeTools(exposedConnectorTools, {
    trigger: run.trigger,
    clientNonce: run.clientNonce,
  });
  const connectorTools = new Map(strategicConnectorTools.map((tool) => [tool.name, tool] as const));
  const trustLoaders = createRunTrustLoaders(deps, {
    run,
    runId,
    botId: bot.id,
    taskPrompt: task.prompt,
    ownerStartedRun,
    messagingChannelRun: nonOwnerChatRun,
    sourceMessage,
    ownerChatMessageBlocks: nonOwnerChatRun ? undefined : sourceBlocks,
    connectedPlugins,
  });
  // Outbound destinations this run may reach without asking. See outboundSiteGate and
  // connectorReadRequiresApproval; approvals from earlier attempts are read back from effects.
  const searchResultUrls = new Set<string>();
  const initiallyTainted =
    run.trigger === BACKGROUND_HELPER_TRIGGER ||
    run.trigger === HELPER_RESULT_TRIGGER ||
    !ownerStartedRun ||
    Boolean(turnCheckpoint) ||
    Boolean(checkpointLoadError) ||
    historyReplaysOutsideContent(history);
  // What Auto Review checks a call's targets against: a run someone else started carries their
  // words in its task, and replayed history the results earlier turns read.
  const initialOutsideText = [
    ...(taskPromptIsOutside(run, ownerStartedRun) ? [task.prompt] : []),
    ...historyToolResults(history),
  ].reduce<string>(appendOutsideText, "");
  // The creation intro only asks what the bot is for (see selectBuiltinToolsForRun),
  // so it gets no connector tools either.
  const tools =
    run.trigger === "created"
      ? strategicBuiltins
      : [...strategicBuiltins, ...strategicConnectorTools];
  // Reasons come from the bot's own settings, not the handoff_to_bot entry added above.
  const unavailableToolReasons = unavailableBuiltinToolReasons(
    {
      groupId: conversationThread.groupId,
      trigger: run.trigger,
      disabledBuiltinTools: bot.disabledBuiltinTools,
    },
    tools,
  );
  const taskCatalogInstruction = tools.some((tool) => tool.name === "task_catalog")
    ? TASK_CATALOG_GUIDANCE
    : undefined;
  const approvedEffects = await deps.prisma.externalEffect.findMany({
    where: { runId, status: "approved" },
    orderBy: APPROVED_EFFECT_REPLAY_ORDER,
    select: { kind: true, request: true, idempotencyKey: true },
  });
  const approvedEffectReplays = createApprovedEffectReplayQueue(approvedEffects);
  return {
    teammates,
    myChatsAllowed,
    strategicBuiltins,
    connectorTools,
    trustLoaders,
    searchResultUrls,
    initiallyTainted,
    initialOutsideText,
    tools,
    unavailableToolReasons,
    taskCatalogInstruction,
    approvedEffects,
    approvedEffectReplays,
  };
}

export type SelectedRunTools = Awaited<ReturnType<typeof selectRunTools>>;

export async function loadComputerInstructions(
  hold: RunHold,
  parts: {
    records: RunRecords;
    connected: ConnectedRun;
    computer: PreparedRunComputer;
    capabilities: RunCapabilities;
    tools: SelectedRunTools;
  },
) {
  const { deps } = hold;
  const { heldForTakeover } = hold.takeover;
  const { bot } = parts.records;
  const { context } = parts.connected;
  const { computerKind, computerMode, graphical, runComputer, storedComputer } = parts.computer;
  const { disabledBuiltinTools, graphicalToolsAllowed } = parts.capabilities;
  const { tools } = parts.tools;
  const baseComputerInstruction = persistentComputerInstruction({
    heldForTakeover,
    graphicalToolsAllowed,
    graphical,
    disabled: disabledBuiltinTools,
  });
  const offeredToolNames = new Set(tools.map((tool) => tool.name));
  const dockerToolInstruction = dockerComputerToolInstruction(
    computerKind,
    disabledBuiltinTools,
    offeredToolNames,
  );
  const hostEnvironment = sandboxKindCapabilities(computerKind).nativeShell
    ? await deps.sandbox
        .environment?.(
          {
            id: storedComputer.providerRef ?? storedComputer.id,
            botId: storedComputer.homeKey,
            kind: computerKind,
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
    ? hostComputerInstruction(computerKind, hostEnvironment)
    : undefined;
  const computerInstruction = [
    COMPUTER_USE_INSTRUCTION,
    hostInstruction
      ? `${baseComputerInstruction} ${hostInstruction}`
      : dockerToolInstruction
        ? `${baseComputerInstruction} ${dockerToolInstruction}`
        : baseComputerInstruction,
    diskNoteInstruction(storedComputer),
  ]
    .filter(Boolean)
    .join(" ");
  const workspaceInstruction =
    computerMode === "team" ? teamWorkspaceInstruction(bot.id) : PRIVATE_WORKSPACE_INSTRUCTION;
  return { hostEnvironment, computerInstruction, workspaceInstruction };
}

export type ComputerInstructions = Awaited<ReturnType<typeof loadComputerInstructions>>;
