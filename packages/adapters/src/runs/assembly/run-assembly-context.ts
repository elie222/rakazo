import type { AgentRunRequest } from "@rakazo/adapter-kit";
import {
  expandSkillReferencesInPrompt,
  formatSkillRunPrompt,
  formatSkillsCatalogInstruction,
  promptInvokesSkill,
  redactSecrets,
  renderBotDirectory,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { loadBotGroupDirectory } from "../../bots/group-handoff.js";
import { parsePlaybook } from "../../bots/teaching-session.js";
import type { RunMediaSources } from "../../media/media-sources.js";
import { lateRoutineRunInstruction } from "../../routines/routine-lateness.prompt.js";
import { routineRunInstruction } from "../../routines/routine-run.prompt.js";
import { formatCompactedSummary } from "../../runtime/context/history-compaction.prompt.js";
import { inferScript } from "../../runtime/scripted-runtime.js";
import { partitionTools } from "../../tools/builtin-tool-bridge.js";
import type { FleetRun } from "../../tools/fleet-tools.js";
import { builtinAgentSkillRecords } from "../../tools/skill-tools.js";
import type { RunExecutorServices, RunHold } from "../lifecycle/run-attempt.js";
import { buildApprovalContinuation } from "../lifecycle/run-effects.js";
import { createReplyState } from "../lifecycle/run-progress.js";
import { withLatestStepScreenshot, withRecentTurnImages } from "../turn/run-turn-images.js";
import { missingTurnImagesInstruction } from "../turn/run-turn-images.prompt.js";
import { checkpointAnswerHistory } from "./checkpoint-answer-history.js";
import { formatCurrentTimeInstruction } from "./current-time.prompt.js";
import { loadReplyContext } from "./reply-context.js";
import type {
  ComputerInstructions,
  PreparedRunComputer,
  RunCapabilities,
  SelectedRunTools,
  StartedTurnModel,
} from "./run-assembly-capabilities.js";
import type { ThreadHistory, TurnContext } from "./run-assembly-history.js";
import type { ConnectedRun, RunRecords, SavedTurn } from "./run-assembly-records.js";
import type { RunContext, RunState } from "./run-context.js";
import { restoreTurnCheckpointEffects } from "./run-context.js";
import {
  connectedPluginsInstruction,
  taughtSkillsInstruction,
  voiceCallInstruction,
} from "./run-instructions.prompt.js";
import { loadSharedSpaceNote } from "./shared-space-note.js";
import { loadTopicActivityContext, loadTopicRootContext } from "./topic-context.js";

export async function createRunContext(
  services: RunExecutorServices,
  hold: RunHold,
  parts: {
    saved: SavedTurn;
    records: RunRecords;
    connected: ConnectedRun;
    turnContext: TurnContext;
    model: StartedTurnModel;
    computer: PreparedRunComputer;
    capabilities: RunCapabilities;
    tools: SelectedRunTools;
    computerInstructions: ComputerInstructions;
    meetingChat: boolean;
    media: RunMediaSources;
  },
) {
  const { web, mediaGeneration, paidServices, browser } = services;
  const {
    deps,
    run,
    runId,
    workerId,
    fence,
    attempt,
    lease,
    computerUse,
    runningHelpers,
    settleHelpers,
    stopHeartbeatAfterCompletion,
    secrets: runSecrets,
  } = hold;
  const { heldForTakeover, takeoverResume } = hold.takeover;
  const { storedTurnCheckpoint } = parts.saved;
  const {
    bot,
    channelId,
    historySearchBeforeSeq,
    nonOwnerChatRun,
    peerMessage,
    task,
    thread,
    conversationThread,
  } = parts.records;
  const { connectedPlugins, context, memoryScope, runAbortController, semanticMemory } =
    parts.connected;
  const { allowSilentEmptyRun, emptyResponseText, groupReplyOptional } = parts.turnContext;
  const { scripted } = parts.model;
  const {
    computerKind,
    computerMode,
    earlierFiles,
    getRunComputer,
    graphical,
    modelSeesImages,
    runComputer,
    storedComputer,
    workspaceCheckpoint,
  } = parts.computer;
  const {
    acceptsImages,
    callClientNonceForRun,
    callEndRun,
    cloudAgent,
    disabledBuiltinTools,
    graphicalToolsAllowed,
    ownerStartedRun,
    pageBrowserAllowed,
    replyMode,
    userComputerOwnerId,
    voiceCall,
  } = parts.capabilities;
  const {
    approvedEffectReplays,
    connectorTools,
    initiallyTainted,
    myChatsAllowed,
    initialOutsideText,
    searchResultUrls,
    strategicBuiltins,
    tools,
    trustLoaders,
  } = parts.tools;
  const { hostEnvironment } = parts.computerInstructions;
  const reply = await createReplyState(deps, run, runSecrets);
  const script = scripted ? inferScript(task.prompt, takeoverResume?.checkpoint) : undefined;
  const state: RunState = {
    lease,
    computerUse,
    runningHelpers,
    reply,
    approval: { pausePending: false, request: undefined },
    effects: {
      counts: new Map(),
      occurrences: [],
      restoredPending: undefined,
      consumedIds: new Set(),
      pendingTurnCheckpoints: new Map(),
      storedTurnCheckpoint,
    },
    screen: {
      lastFrameId: undefined,
      unchangedVisualStreak: { count: 0 },
      turn: { controlFence: undefined, mustLook: false },
    },
    toolCallStreak: { key: undefined, count: 0 },
    overLimitActionCalls: 0,
    toolResults: new Map(),
    tainted: initiallyTainted,
    taintedBeyondOwnComputer: initiallyTainted,
    outsideText: initialOutsideText,
    // A resumed turn replaces this with the baseline its saved prompt was built from.
    ownInstructionsBaseline: bot.instructions ?? "",
    earlierAttempt: undefined,
    walletHosts: new Set(),
    vaultUses: new Set(),
    handedOff: false,
    terminalCheckpointComplete: false,
  };
  /** Fleet tools take every scope from the run, never from arguments. */
  const fleetRun: FleetRun = {
    spaceId: run.spaceId,
    userId: run.userId,
    botId: bot.id,
    groupId: conversationThread.groupId ?? null,
    threadId: conversationThread.id,
    runId,
  };

  const ctx: RunContext = {
    deps,
    providers: { web, mediaGeneration, media: parts.media, paidServices, browser, cloudAgent },
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
    runtimeAbortController: new AbortController(),
    fleetRun,
    secrets: runSecrets,
    source: {
      ownerStartedRun,
      meetingChat: parts.meetingChat,
      messagingChannelRun: nonOwnerChatRun,
      channelId,
      historySearchBeforeSeq,
      conversationThreadId: conversationThread.id,
      myChatsAllowed,
      voiceCall,
      callEndRun,
      callClientNonce: callClientNonceForRun,
      peerMessage,
      userComputerOwner: userComputerOwnerId,
      ownerComputerRoutine: parts.records.ownerComputerRoutine,
    },
    computer: {
      stored: storedComputer,
      kind: computerKind,
      mode: computerMode,
      get lease() {
        return hold.computerLease;
      },
      lazy: runComputer,
      get: getRunComputer,
      copyEarlierFiles: earlierFiles.add,
      checkpoint: workspaceCheckpoint,
      hostEnvironment,
      graphical,
      graphicalToolsAllowed,
      pageBrowserAllowed,
      acceptsImages,
      modelSeesImages,
      heldForTakeover,
    },
    tools: {
      offered: tools,
      builtins: strategicBuiltins,
      connector: connectorTools,
      disabled: disabledBuiltinTools,
      connectedPlugins,
      approvedReplays: approvedEffectReplays,
      activation: parts.connected.toolActivation,
    },
    trust: { ...trustLoaders, searchResultUrls },
    memory: {
      semantic: semanticMemory,
      scope: memoryScope,
    },
    scripted,
    script,
    allowSilentEmptyRun,
    groupReplyOptional,
    emptyResponseText,
    replyMode,
    state,
    settleRunningHelpers: settleHelpers,
    stopHeartbeatAfterCompletion,
  };
  return ctx;
}

export async function buildTurnPrompt(
  hold: RunHold,
  parts: {
    saved: SavedTurn;
    records: RunRecords;
    connected: ConnectedRun;
    thread: ThreadHistory;
    turnContext: TurnContext;
    model: StartedTurnModel;
    computer: PreparedRunComputer;
    capabilities: RunCapabilities;
    tools: SelectedRunTools;
    ctx: RunContext;
    meetingContext?: string;
  },
) {
  const { deps, run, current, executionStartedAt, firstLateSince, secrets: runSecrets } = hold;
  const { takeoverResume } = hold.takeover;
  const { checkpointModelResolver, savedComputerMode } = parts.saved;
  let { turnCheckpoint } = parts.saved;
  const {
    agentSkills,
    nonOwnerChatRun,
    ownerComputerRoutine,
    savedSkills,
    task,
    thread,
    conversationThread,
  } = parts.records;
  const { connectedPlugins, context } = parts.connected;
  const { compactedHistory, people, speakers } = parts.thread;
  const {
    currentTurnImages,
    currentTurnMessage,
    history,
    historyMessages,
    recalledMemory,
    turnBlocks,
  } = parts.turnContext;
  const { resolved, runModelId, runModelProvider } = parts.model;
  const { attachedFilesPrompt, modelSeesImages } = parts.computer;
  const { callEndRun, disabledBuiltinTools, ownerStartedRun, voiceCall } = parts.capabilities;
  const { approvedEffects, tools } = parts.tools;
  const { ctx } = parts;
  // A routine with its owner's computer runs the exact text they approved, skills already expanded,
  // and reads no app or skill names, which others can change after the owner approved it.
  const pluginLine = ownerComputerRoutine
    ? undefined
    : connectedPluginsInstruction(connectedPlugins);
  const runSavedSkills = nonOwnerChatRun || ownerComputerRoutine ? [] : savedSkills;
  const runAgentSkills = ownerComputerRoutine
    ? []
    : nonOwnerChatRun
      ? builtinAgentSkillRecords()
      : agentSkills;
  const taughtSkillIndex = runSavedSkills.slice(0, 20);
  const taughtSkillsLine = taughtSkillsInstruction(
    taughtSkillIndex.map((skill) => ({
      name: skill.name || skill.goal.slice(0, 80),
      whenToUse: parsePlaybook(skill.playbook).whenToUse || skill.goal,
    })),
  );
  const agentSkillsLine = formatSkillsCatalogInstruction(runAgentSkills);
  const missingImagesInstruction = missingTurnImagesInstruction(turnBlocks, currentTurnImages);
  const taskPrompt = expandSkillReferencesInPrompt(
    [task.prompt, attachedFilesPrompt, missingImagesInstruction].filter(Boolean).join("\n\n"),
    runAgentSkills,
  );
  const invokedSkill = runSavedSkills.find(
    (skill) =>
      // Taught skills are the space's. Only a person's own message may pull in one someone
      // else taught; any other run, a routine included, follows only those its own person taught.
      ((ownerStartedRun && run.trigger !== "routine") || skill.userId === run.userId) &&
      promptInvokesSkill(taskPrompt, skill.name || skill.goal),
  );
  const basePrompt = invokedSkill
    ? `${formatSkillRunPrompt(
        invokedSkill.name || invokedSkill.goal.slice(0, 80),
        parsePlaybook(invokedSkill.playbook),
      )}\n\n${taskPrompt}`
    : taskPrompt;
  if (turnCheckpoint) {
    turnCheckpoint = restoreTurnCheckpointEffects(
      ctx,
      turnCheckpoint,
      {
        provider: runModelProvider,
        id: runModelId,
      },
      savedComputerMode?.mode,
    );
    if (checkpointModelResolver && !turnCheckpoint)
      throw new Error("Pinned computer mode checkpoint cannot be restored");
  }
  const approvalContinuation = turnCheckpoint
    ? undefined
    : buildApprovalContinuation(
        approvedEffects,
        (request) => redactSecrets(JSON.stringify(request), runSecrets),
        { exposedToolNames: new Set(partitionTools(tools).listed.map((tool) => tool.name)) },
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
  let routineNote: string | undefined;
  let lateRoutineNote: string | undefined;
  const lateSince = current.lateSince ?? firstLateSince;
  // Daily check-ins share the routine trigger but belong to no routine.
  if (run.trigger === "routine" && run.routineId) {
    const routine = await bestEffort(
      "load the routine for its run's prompt",
      deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { name: true, timezone: true },
      }),
    );
    // The name is not part of what the owner approved, and any of their runs can rename it.
    routineNote = routineRunInstruction(
      ownerComputerRoutine ? undefined : routine?.name,
      parts.records.historyReach === "recent",
    );
    if (routine && lateSince)
      lateRoutineNote = lateRoutineRunInstruction(lateSince, executionStartedAt, routine.timezone);
  }
  // Other members' account names are text the owner of a routine with their computer never approved.
  const sharedSpaceNote =
    people && !ownerComputerRoutine
      ? await loadSharedSpaceNote(deps.prisma, run.spaceId, run.userId)
      : undefined;
  const readsHistory = parts.records.historyReach !== "none";
  // Per turn, after the history: the chat hears what moved in its threads without their replies.
  // Only the owner's own chat turns: a routine or a channel reads just what its history rules allow.
  const topicActivity =
    readsHistory && thread.botId && !nonOwnerChatRun && run.trigger !== "routine"
      ? await bestEffort(
          "summarize thread activity for the chat",
          loadTopicActivityContext(deps.prisma, {
            mainThreadId: thread.id,
            userId: run.userId,
            since: previousMessageAt(historyMessages, currentTurnMessage?.id),
          }),
        )
      : undefined;
  const topicRoot = readsHistory ? await loadTopicRootContext(deps.prisma, thread) : undefined;
  const prompt = [
    replyContext,
    parts.meetingContext,
    routineNote,
    run.trigger === "reaction" && replyContext ? undefined : basePrompt,
    takeoverResume?.promptNote,
    approvalContinuation,
    // A hang-up turn is read, not heard: no spoken-reply constraint.
    voiceCall && !callEndRun ? voiceCallInstruction(disabledBuiltinTools) : undefined,
    // Per-turn, not in the system prompt: the timestamp changes every call and would break the cacheable prefix.
    // Tagged so it is never read as part of what the user asked for, such as text to save.
    `<current_time>\n${formatCurrentTimeInstruction(
      deps.now?.() ?? new Date(),
      userTimeZone,
      previousMessageAt(historyMessages, currentTurnMessage?.id),
    )}\n</current_time>`,
    lateRoutineNote,
    sharedSpaceNote,
    topicActivity,
  ]
    .filter(Boolean)
    .join("\n\n");
  const historicalContext: AgentRunRequest["history"] = [];
  if (topicRoot) {
    historicalContext.push({ role: "user", content: redactSecrets(topicRoot, runSecrets) });
  }
  if (compactedHistory.usedLocalSummary && compactedHistory.summary) {
    historicalContext.push({
      role: "user",
      content: redactSecrets(
        formatCompactedSummary(compactedHistory.summary, thread.historyCompactedUpToSeq!),
        runSecrets,
      ),
    });
  }
  // Recall changes with each run's request, so it goes after the kept history: placed before
  // it, the history would no longer be a prefix the provider's prompt cache can reuse.
  const recalledContext: AgentRunRequest["history"] = recalledMemory
    ? [{ role: "user", content: redactSecrets(recalledMemory, runSecrets) }]
    : [];
  const resumeHistory = turnCheckpoint
    ? await checkpointAnswerHistory(
        deps.prisma,
        run,
        history,
        parts.records.messages,
        Boolean(speakers),
      )
    : undefined;
  const replayHistory = resumeHistory?.history ?? history;
  const modelImageBudget =
    resolved.maxImagesPerPrompt === undefined
      ? undefined
      : Math.max(0, resolved.maxImagesPerPrompt - (currentTurnImages?.length ?? 0));
  // A text-only model keeps the [image:] marker. Putting image parts in
  // history makes the provider reject a follow-up that used to be text.
  const historyWithImages = modelSeesImages
    ? await withLatestStepScreenshot(
        deps,
        await withRecentTurnImages(deps, replayHistory, historyMessages, context, {
          skipMessageId: currentTurnMessage?.id,
          maxImages: modelImageBudget,
        }),
        context,
      )
    : replayHistory;
  const runtimeHistory = [...historicalContext, ...historyWithImages, ...recalledContext];
  const groupDirectory =
    conversationThread.groupId || ownerComputerRoutine
      ? undefined
      : await loadBotGroupDirectory(deps.prisma, run);
  const botDirectory =
    [renderBotDirectory(parts.tools.teammates), groupDirectory].filter(Boolean).join("\n\n") ||
    undefined;
  return {
    pluginLine,
    taughtSkillsLine,
    agentSkillsLine,
    taskPrompt,
    prompt,
    hasHistoricalContext: historicalContext.length + recalledContext.length > 0,
    runtimeHistory,
    resumeHistoryMessageIds: resumeHistory?.representedMessageIds,
    resumeAnswerReplyContexts: resumeHistory?.answerReplyContexts,
    botDirectory,
    turnCheckpoint,
  };
}

export type TurnPrompt = Awaited<ReturnType<typeof buildTurnPrompt>>;

/** When the newest message other than this turn's was sent, read before compaction drops it. */
export function previousMessageAt(
  messages: ReadonlyArray<{ id: string; createdAt?: Date | null }>,
  currentId: string | undefined,
): Date | undefined {
  let latest: Date | undefined;
  for (const message of messages) {
    if (message.id === currentId || !message.createdAt) continue;
    if (!latest || message.createdAt > latest) latest = message.createdAt;
  }
  return latest;
}
