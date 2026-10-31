import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  ConnectorTool,
  MediaGenerationProvider,
  SandboxProvider,
  SemanticMemoryProvider,
  WebProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import type { ToolCallStreak } from "@rakazo/core";
import { createStreamingRedactor } from "@rakazo/core";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { Bot, Computer, effectiveMemoryScope, Run, Task, Thread } from "@rakazo/db";
import { dropRunTurnCheckpoint, saveRunTurnCheckpoint } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ApprovalPausedToolResult, ApprovedEffectReplayQueue } from "./approval-effect.js";
import { approvalPausedToolResult, approvedEffectOccurrence } from "./approval-effect.js";
import type { loadBotMessageContext } from "./bot-messages.js";
import { partitionTools } from "./builtin-tool-bridge.js";
import type { ComputerExecutionLease } from "./computer-lifecycle.js";
import type { UnchangedVisualStreak } from "./computer-tools.js";
import type { selectRunConnections } from "./connection-context.js";
import type { ExecutorDeps } from "./executor-deps.js";
import type { FleetRun } from "./fleet-tools.js";
import { namedAgentTools } from "./pi-runtime-tools.js";
import type { lazyRunComputer } from "./run-computer.js";
import type { createRunWorkspaceCheckpoint } from "./run-lifecycle.js";
import { publishMessage } from "./run-messages.js";
import { subagentMarksUnread } from "./run-notifications.js";
import { secretPausedToolResult } from "./run-secret.js";
import type { createRunTrustLoaders } from "./run-trust.js";
import type { inferScript } from "./scripted-runtime.js";
import { restoreTurnCheckpoint, unresolvedTurnCheckpointCalls } from "./turn-checkpoint.js";

export type RunningHelper = Omit<Extract<MessageBlock, { kind: "subagent" }>, "kind">;

export type ScreenRelease = { computer: ComputerRef; context: AdapterContext; keepWarm: boolean };

export type EffectOccurrence = { executionId: string; fingerprint: string; occurrence: number };

export interface RunLeaseState {
  valid: boolean;
  /** The run reached a final state; the heartbeat stops renewing. */
  completed: boolean;
  lastCheckAt: number;
  /** A takeover keeps the computer lease past this attempt. */
  retainComputer: boolean;
}

export interface RunComputerUseState {
  reason: "none" | "tool" | "takeover" | "script";
  tool: string | undefined;
  /** Set once the computer started, so cleanup releases its screen. */
  screenRelease: ScreenRelease | undefined;
}

export interface ReplyState {
  assembled: string;
  currentTextSegment: string;
  messageSegments: MessageBlock[];
  /**
   * Terminal subagent rows are published as their own messages (not appended to
   * messageSegments). Treat that like tool/step durable activity so we do not invent
   * an empty-run "done." completion afterward.
   */
  publishedTerminalSubagent: boolean;
  /**
   * Durable chat messages posted mid-turn (message_user / promoted narration).
   * Rehydrated from this run's prior progress rows so a resume after ask/takeover
   * still knows progress was already published (skip hollow finals; status outcome).
   */
  publishedMidTurnUserMessage: boolean;
  /**
   * Some runs hold back pre-tool narration instead of posting it as chat.
   * Keep the last segment in case the model supplies no final reply.
   */
  discardedMidTurnNarration: boolean;
  lastDiscardedMidTurnNarration: string;
  explicitNoResponse: boolean;
  assistantTurnText: string;
  midTurnUserTexts: string[];
  midTurnProgressCount: number;
  turnStartedAtMs: number;
  /** A message from the person mid-task starts a fresh budget from here (see "steered"). */
  progressBudgetStart: number;
  /** The first interim message after one may answer the person at once. */
  steeringReplyPending: boolean;
  steeringResets: number;
  lastSteeringResetAt: number;
  /**
   * Notes on steps since the last interim message, in order; they come back as the reply when
   * nothing follows the last step.
   */
  workingNotes: string[];
  /** Text taken out before steps so far, joined as written, so a secret split across two is hidden. */
  narrationSoFar: string;
  /** What the bot wrote since its last step: empty means nothing follows the last step. */
  textSinceLastStep: string;
  /** The working line shows a note; tool status lines wait until the bot writes again. */
  narrationStatusShowing: boolean;
  /**
   * Tool calls that land mid-sentence wait here until the narration catches up to a
   * sentence boundary, so the step chips never render in the middle of a clause.
   */
  pendingToolNames: string[];
  pendingProgress: string;
  lastProgressAt: number;
  hasStreamedText: boolean;
  /**
   * Set by a tool call or a new assistant message: the next text starts a new
   * assistant turn and needs a break from the earlier text that stayed in this reply.
   */
  assistantTurnBreakPending: boolean;
  /** Replaced whenever a secret is added, so streamed progress hides it too. */
  redactor: ReturnType<typeof createStreamingRedactor>;
}

export interface ApprovalState {
  /** A tool paused the run for approval or protected input; the turn ends. */
  pausePending: boolean;
  /** The first card of parallel calls that need approval; the others wait for it. */
  request: Promise<ApprovalPausedToolResult> | undefined;
}

/** Which occurrence of an identical effect each tool call claims, across pauses. */
export interface EffectState {
  /** Next free occurrence per effect fingerprint. */
  counts: Map<string, number>;
  /** Occurrences assigned in this turn, saved with its checkpoint. */
  occurrences: EffectOccurrence[];
  restoredPending: EffectOccurrence | undefined;
  consumedIds: Set<string>;
  /** Turn snapshots captured before each tool call, by execution id. */
  pendingTurnCheckpoints: Map<string, () => string>;
  storedTurnCheckpoint: boolean;
}

export interface ScreenState {
  lastFrameId: string | undefined;
  unchangedVisualStreak: UnchangedVisualStreak;
}

/** What one attempt changes while it runs. Every piece shares these objects by reference. */
export interface RunState {
  lease: RunLeaseState;
  computerUse: RunComputerUseState;
  /**
   * Helpers whose running state this attempt persisted. Runtime cleanup can queue their
   * terminal events after the consumer exits, so the attempt settles them itself.
   */
  runningHelpers: Map<string, RunningHelper>;
  reply: ReplyState;
  approval: ApprovalState;
  effects: EffectState;
  screen: ScreenState;
  toolCallStreak: ToolCallStreak;
  /**
   * Whether outside content has entered the run. A run someone else started begins tainted,
   * and so does a later attempt, including one with restored untrusted tool results.
   */
  tainted: boolean;
  earlierAttempt: Promise<boolean> | undefined;
  handedOff: boolean;
  terminalCheckpointComplete: boolean;
}

export interface RunComputerContext {
  stored: Computer;
  mode: ComputerMode;
  lease: ComputerExecutionLease | null;
  lazy: ReturnType<typeof lazyRunComputer>;
  /** Starts the computer on first use and copies the turn's files before each tool. */
  get: (reason: "tool" | "takeover" | "script", tool?: string) => Promise<ComputerRef>;
  checkpoint: ReturnType<typeof createRunWorkspaceCheckpoint>;
  hostEnvironment: Awaited<ReturnType<NonNullable<SandboxProvider["environment"]>>> | undefined;
  graphical: boolean;
  graphicalToolsAllowed: boolean;
  pageBrowserAllowed: boolean;
  acceptsImages: boolean;
  heldForTakeover: boolean;
}

export interface RunSource {
  ownerStartedRun: boolean;
  messagingChannelRun: boolean;
  channelId: string | undefined;
  historySearchBeforeSeq: number;
  /** See historyMyChatsAllowed; claimed outside steering still revokes it per call. */
  myChatsAllowed: boolean;
  voiceCall: boolean;
  callEndRun: boolean;
  callClientNonce: string | null;
  peerMessage: Awaited<ReturnType<typeof loadBotMessageContext>>;
  /** Whose own computer user_computer_shell may reach (see userComputerOwner). */
  userComputerOwner: string | undefined;
}

export interface RunTools {
  offered: ConnectorTool[];
  builtins: ConnectorTool[];
  connector: Map<string, ConnectorTool>;
  disabled: Set<string>;
  connectedPlugins: ReturnType<typeof selectRunConnections>;
  approvedReplays: ApprovedEffectReplayQueue;
}

export type RunTrust = ReturnType<typeof createRunTrustLoaders> & {
  /** Exact URLs a web search returned; fetching one needs no approval. */
  searchResultUrls: Set<string>;
};

export interface RunProviders {
  web: WebProvider;
  mediaGeneration: MediaGenerationProvider | undefined;
  browser: BrowserProvider;
  cloudAgent: ExecutorDeps["cloudAgent"];
}

/**
 * One attempt of one run: its immutable facts, the services it calls, and the mutable
 * {@link RunState}. Created once per attempt in continueRun and passed whole to tools and
 * the turn loop instead of closing over dozens of locals.
 */
export interface RunContext {
  deps: ExecutorDeps;
  providers: RunProviders;
  run: Run;
  runId: string;
  workerId: string;
  fence: number;
  attempt: { id: string };
  bot: Bot & { computer: Computer | null };
  thread: Thread;
  task: Task;
  /** Provider context for this run's calls; aborting the run aborts its signal. */
  context: AdapterContext;
  abortController: AbortController;
  fleetRun: FleetRun;
  /** Every value redacted from what this run shows or stores. Grows during the run. */
  secrets: string[];
  source: RunSource;
  computer: RunComputerContext;
  tools: RunTools;
  trust: RunTrust;
  memory: {
    semantic: SemanticMemoryProvider | null;
    scope: ReturnType<typeof effectiveMemoryScope> | null;
  };
  scripted: boolean;
  script: ReturnType<typeof inferScript> | undefined;
  allowSilentEmptyRun: boolean;
  emptyResponseText: string | undefined;
  state: RunState;
  settleRunningHelpers: () => Promise<void>;
  stopHeartbeatAfterCompletion: () => void;
}

export async function settleRunningHelpers(
  deps: ExecutorDeps,
  run: Run,
  runningHelpers: Map<string, RunningHelper>,
) {
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
}

/** Redact values a tool just revealed, including in progress already buffered. */
export function addRunSecrets(ctx: RunContext, values: string[]) {
  const { reply } = ctx.state;
  const additions = values.filter((value) => !ctx.secrets.includes(value));
  if (additions.length === 0) return;
  reply.pendingProgress += reply.redactor.finish();
  ctx.secrets.push(...additions);
  reply.redactor = createStreamingRedactor(ctx.secrets);
}

export function pauseForApproval(ctx: RunContext) {
  ctx.state.approval.pausePending = true;
  return approvalPausedToolResult();
}

export function pauseForSecret(ctx: RunContext) {
  ctx.state.approval.pausePending = true;
  return secretPausedToolResult();
}

/** The owner chose Never ask for this space. */
export async function neverAsks(ctx: RunContext) {
  return (await ctx.trust.loadAutoReviewPreference()).skipApprovals;
}

export async function isRunTainted(ctx: RunContext) {
  const { state } = ctx;
  if (state.tainted) return true;
  state.earlierAttempt ??= ctx.deps.prisma.attempt
    .count({ where: { runId: ctx.runId } })
    .then((count) => count > 1);
  if ((await state.earlierAttempt) || (await ctx.trust.receivedOutsideMessage()))
    state.tainted = true;
  return state.tainted;
}

export function nextMutatingEffectOccurrence(
  ctx: RunContext,
  toolName: string,
  args: Record<string, unknown>,
  executionId: string,
  approvedKey?: string,
) {
  const effects = ctx.state.effects;
  const fingerprint = toolEffectIdempotencyKey(ctx.runId, toolName, args);
  const approved = approvedKey ? approvedEffectOccurrence(approvedKey, fingerprint) : undefined;
  const previous = effects.restoredPending;
  if (previous?.executionId === executionId) {
    effects.restoredPending = undefined;
    if (previous.fingerprint === fingerprint && approved === undefined) return previous.occurrence;
  }
  // An approved replay reuses the approved row's occurrence, so it claims that row
  // even when this call would have counted differently.
  const occurrence = approved ?? effects.counts.get(fingerprint) ?? 0;
  effects.occurrences.push({ executionId, fingerprint, occurrence });
  effects.counts.set(fingerprint, Math.max(effects.counts.get(fingerprint) ?? 0, occurrence + 1));
  return occurrence;
}

export async function persistTurnCheckpoint(ctx: RunContext, executionId?: string) {
  const { deps, run, workerId, fence } = ctx;
  const effects = ctx.state.effects;
  const capture = executionId ? effects.pendingTurnCheckpoints.get(executionId) : undefined;
  if (capture) {
    const saved = JSON.parse(capture());
    saved.effectOccurrences = effects.occurrences;
    await saveRunTurnCheckpoint(deps.prisma, run, workerId, fence, JSON.stringify(saved));
    effects.storedTurnCheckpoint = true;
  } else if (effects.storedTurnCheckpoint) {
    // Helper calls have no saved turn. An earlier pause's turn must not resume this one.
    await dropRunTurnCheckpoint(deps.prisma, run, workerId, fence);
    effects.storedTurnCheckpoint = false;
  }
}

/**
 * Reserve the effect occurrences a saved turn already assigned, so its pending call claims the
 * same effect when it resumes. Returns undefined when the turn cannot resume with this run's
 * tools or transcript format.
 */
export function restoreTurnCheckpointEffects(
  ctx: RunContext,
  turnCheckpoint: string,
  model: { provider: string; id: string },
): string | undefined {
  const effects = ctx.state.effects;
  try {
    const saved = restoreTurnCheckpoint(turnCheckpoint, model);
    const unresolved = new Set(unresolvedTurnCheckpointCalls(saved.messages));
    const namedTools = namedAgentTools(partitionTools(ctx.tools.offered).listed);
    const available = new Set(namedTools.map((tool) => tool.name));
    if (
      saved.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (call) =>
              call.type === "toolCall" &&
              unresolved.has(call) &&
              (saved.executionMode === "sequential" || call.id === saved.pendingToolCallId) &&
              !available.has(call.name),
          ),
      )
    ) {
      return undefined;
    }
    if (saved.effectOccurrences) {
      effects.occurrences.push(...saved.effectOccurrences);
      const pendingExecutionId = JSON.stringify(["pi-tool", "main", saved.pendingToolCallId]);
      // Provider IDs can repeat in later responses. Only the restored
      // pending call may consume its saved assignment, exactly once.
      effects.restoredPending = saved.effectOccurrences.findLast(
        (entry) => entry.executionId === pendingExecutionId,
      );
      for (const { fingerprint, occurrence } of saved.effectOccurrences) {
        effects.counts.set(
          fingerprint,
          Math.max(effects.counts.get(fingerprint) ?? 0, occurrence + 1),
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
              ctx,
              tool.name,
              call.arguments,
              JSON.stringify(["pi-tool", "main", call.id]),
            );
        }
      }
    }
    return turnCheckpoint;
  } catch {
    // Incompatible transcripts use the existing canonical approval replay.
    // Decryption happens earlier and must still fail closed.
    return undefined;
  }
}
