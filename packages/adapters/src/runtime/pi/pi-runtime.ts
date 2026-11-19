import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  JsonValue,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSteeringMessage,
  AgentUsage,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import {
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_OUTPUT_CUT_ERROR,
  modelFallbackFailure,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import {
  isTerminatingReplyResult,
  terminatingReplyText,
  uncertainEffectResult,
} from "../../approvals/approval-effect.js";
import { deliverFinishedShells } from "../../computers/sandbox/shell-command-stream.js";
import { withAutomatedLabels } from "../../messaging/automated-messages.js";
import { withCloudflareAuth } from "../../models/endpoints/cloudflare-ai-gateway.js";
import {
  CUT_REPLY_CONTINUATION_PROMPT,
  cutReplyAtLimitPrompt,
  SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT,
  SILENT_TOOL_CONTINUATION_PROMPT,
} from "../../runs/assembly/continuation.prompt.js";
import {
  midTaskMessageFromPrompt,
  midTaskMessagePrompt,
} from "../../runs/assembly/run-replies.prompt.js";
import { runToolCallIds, uniqueToolCallIdStream } from "../../runs/turn/tool-call-ids.js";
import type { ComputerModeCheckpoint } from "../../runs/turn/turn-checkpoint.js";
import {
  restoreTurnCheckpoint,
  serializeTurnCheckpoint,
  unresolvedTurnCheckpointCalls,
  withoutSavedMeetingResult,
} from "../../runs/turn/turn-checkpoint.js";
import { neutralizeSpeakerLabels } from "../context/history-speakers.js";
import type { RuntimeContextDecision } from "../context/runtime-context.js";
import { createRuntimeContextPolicy } from "../context/runtime-context.js";
import type { RejectedProviderRequest } from "../provider-request-shape.js";
import { attachRejectedRequests, rejectedRequestsOf } from "../provider-request-shape.js";
import { fallbackSystemPrompt } from "../runtime.prompt.js";
import { withoutThinkingFrom } from "../thinking-signatures.js";
import { estimatePiImageTokens } from "./pi-image-context.js";
import {
  assistantText,
  messageHasToolCall,
  modelFailure,
  providerFailureText,
  sanitizeError,
  sanitizeProviderError,
} from "./pi-runtime-errors.js";
import type { FallbackStreamState } from "./pi-runtime-fallback.js";
import {
  continuationRepeat,
  fallbackAwareModelStream,
  MAX_CONTINUATION_MARKER,
  MAX_CONTINUATION_OVERLAP,
  MAX_SELF_RECOVERIES_PER_RUN,
} from "./pi-runtime-fallback.js";
import {
  isHistoryReply,
  speakerText,
  toHistory,
  toPiImages,
  withLeadingUser,
  withoutSteeringMessages,
} from "./pi-runtime-history.js";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import {
  cardOutputCeiling,
  modelForCompletion,
  modelTargetKey,
  resizeRuntimeTarget,
  resolveRuntimeModel,
  sameModelTarget,
  thinkingLevelFor,
} from "./pi-runtime-models.js";
import type { PiSessionHandle, PiSessionRecorder } from "./pi-session.js";
import { PiJsonlSessionRecorder } from "./pi-session.js";
import { conversationSessionId, reliableModelStream } from "./stream/pi-runtime-stream.js";
import { withPiThinkingActivity } from "./stream/pi-thinking-activity.js";
import {
  COMPUTER_MODE_TOOLS,
  computerSelection,
  computerTarget,
  computerTransitionTool,
  restoreComputerModels,
} from "./tools/pi-runtime-computer-mode.js";
import type { ToolCallBudget, ToolHost } from "./tools/pi-runtime-tools.js";
import {
  agentToolDefinitions,
  createQueue,
  describeToolActivity,
  redactAskUserDetailInMessage,
  releaseToolCallBudget,
  toAgentTools,
  toolCallBudgetExceededMessage,
  toolCallBudgetFor,
} from "./tools/pi-runtime-tools.js";
import { withPiTelemetry } from "./usage/pi-telemetry.js";
import { observedPiStream } from "./usage/pi-usage.js";

const MAX_REJECTED_REQUESTS = 5;
const ANSWERED_ON_RESUME = new Set(["ask_user", "request_takeover"]);
const running = new Map<string, { controller: AbortController; work: Promise<void> }>();
// Some OpenAI-compatible models return EOS immediately after a tool result
// instead of taking another assistant turn. A bounded internal follow-up keeps
// that provider quirk from making a long task look complete after one step.
const MAX_SILENT_TOOL_CONTINUATIONS = 3;

// Shown as a failed-run error, not an assistant message. Asking the user to
// continue stores that sentence as the reply, and the next "continue" runs
// tools and misses a final answer again.
export { MISSING_TOOL_FINAL_RESPONSE_ERROR } from "@rakazo/core";

export interface PiAgentRuntimeOptions {
  /** Directory where Pi JSONL sessions are written. Omit to disable recording. */
  sessionRoot?: string;
  /** Explicit transport for tests and synthetic wire diagnostics. */
  modelFetch?: typeof globalThis.fetch;
  modelCallObserver?: ModelCallObserver;
  /** Sanitized per-call selection telemetry; never includes prompt or credentials. */
  onContextDecision?: (
    decision: RuntimeContextDecision & {
      runId: string;
      agentId?: string;
      usage: AgentUsage;
    },
  ) => void;
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly sessionRecorder?: PiSessionRecorder;
  private readonly modelFetch?: typeof globalThis.fetch;
  private readonly modelCallObserver?: ModelCallObserver;
  private readonly onContextDecision?: PiAgentRuntimeOptions["onContextDecision"];

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.modelFetch = options.modelFetch;
    this.modelCallObserver = options.modelCallObserver;
    this.onContextDecision = options.onContextDecision;
    this.sessionRecorder = options.sessionRoot
      ? new PiJsonlSessionRecorder(options.sessionRoot)
      : undefined;
  }

  describe() {
    return {
      id: "pi",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: true,
        tools: true,
        scripted: false,
      },
    };
  }

  async abort(runId: string): Promise<void> {
    const active = running.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const events = this.runEvents(request, controller, context);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        // An async generator queues return() behind a pending next(). Abort
        // immediately so a quiet model request can settle that pending read.
        controller.abort();
        return events.return();
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }

  private async *runEvents(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    const signal = context?.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    const queue = createQueue();
    let thinking = false;
    const setThinking = (active: boolean) => {
      const next = active && !signal.aborted;
      if (thinking === next) return;
      thinking = next;
      queue.push({ type: "thinking", active: next });
    };
    const stopThinking = () => setThinking(false);
    signal.addEventListener("abort", stopThinking, { once: true });

    const work = withPiTelemetry(request, async (span) => {
      let trackedBudget: ToolCallBudget | undefined;
      let yielded = false;
      let handBackFailed = false;
      // Ends the turn only once the run's executor has saved it and handed the run back.
      const handBack = (checkpoint: string) =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) return resolve(false);
          const stop = () => resolve(false);
          signal.addEventListener("abort", stop, { once: true });
          queue.push({
            type: "yielded",
            checkpoint,
            answer: (handedBack) => {
              signal.removeEventListener("abort", stop);
              resolve(handedBack);
            },
          });
        });
      let resumeHost: ToolHost | undefined;
      try {
        const saved = request.turnCheckpoint
          ? restoreTurnCheckpoint(request.turnCheckpoint, request.model)
          : undefined;
        const savedMode = saved?.computerMode;
        // An executor that resolved the pinned models already passes them in.
        if (savedMode && !request.computerModel) {
          const pinned = await restoreComputerModels(request, savedMode);
          request = { ...request, model: pinned.main, computerModel: pinned.computer };
        }
        const selectedModel = resolveRuntimeModel(request.model);
        if (!selectedModel.model) {
          queue.push({
            type: "text",
            text: `Unknown model ${selectedModel.provider}/${selectedModel.modelId}`,
          });
          queue.push({ type: "done" });
          return;
        }
        const { models, model, apiKey } = selectedModel;
        const toolDefs = request.tools;
        const completionModel = modelForCompletion(model, request.model.maxTokens);
        trackedBudget = toolCallBudgetFor(
          request.runId,
          typeof saved?.toolCallCount === "number" ? saved.toolCallCount : 0,
        );
        const initialModelTarget: RuntimeModelTarget = {
          config: request.model,
          models,
          model: completionModel,
          cardMaxTokens: cardOutputCeiling(model),
          apiKey,
          credentials: selectedModel.credentials,
        };
        const computer = request.computerModel ? computerTarget(request.computerModel) : undefined;
        let mode = savedMode?.mode ?? "main";
        // Where the current computer-mode span began; a resumed span is not known, so it is all.
        let computerFrom = 0;
        // The last finished span, whose reasoning is not the main model's, even on the same model id.
        let computerSpan: [number, number] | undefined;
        let mainTarget = initialModelTarget;
        let computerMode: ComputerModeCheckpoint | undefined = computer
          ? {
              version: 1,
              mode,
              main: computerSelection(request.model),
              computer: computerSelection(computer.config),
            }
          : undefined;
        const host: ToolHost = {
          queue,
          context,
          modelFetch: this.modelFetch,
          onContextDecision: this.onContextDecision,
          modelCallObserver: this.modelCallObserver,
          request,
          activeModel: mode === "computer" ? computer! : initialModelTarget,
          computerModeAllowed: computer ? () => mode === "computer" : undefined,
          models,
          model: completionModel,
          apiKey,
          toolCallBudget: trackedBudget,
          toolCallSeq: { value: 0 },
          providerToolCallIds: new Map(),
          abortTurn: () => undefined,
          signal,
          pausePending: false,
          pendingShells: [],
          modelResponses: 0,
        };
        resumeHost = host;
        const allTools = toAgentTools(toolDefs, host);
        const toolsByAgentName = agentToolDefinitions(toolDefs);
        // Replayed calls to tools the model no longer has say so in their results.
        const offeredToolNames = new Set(allTools.map((tool) => tool.name));
        // Tools the run can call but does not list are reached through use_tool, and replay so.
        const deferredToolNames = new Set(
          [...toolsByAgentName.keys()].filter((name) => !offeredToolNames.has(name)),
        );
        let tools = allTools;
        const seenSteeringIds: string[] = [];
        const initialSteering = request.claimSteering ? await request.claimSteering([]) : [];
        let hasCurrentImages = Boolean(
          request.currentRunRequiresImageInput ||
            (request.currentTurnImages?.length && !request.currentTurnImageFileFallback) ||
            initialSteering.some((item) => item.images?.length && !item.imageFileFallback),
        );
        seenSteeringIds.push(...initialSteering.map((item) => item.id));
        // A computer-mode checkpoint was written by the computer model; keep its thinking.
        const restored = request.turnCheckpoint
          ? restoreTurnCheckpoint(
              request.turnCheckpoint,
              mode === "computer" && computer ? computer.model : model,
            )
          : undefined;
        const history =
          restored?.messages ??
          toHistory(
            withoutSteeringMessages(request.history, initialSteering),
            request.prompt,
            request.sourceMessageId,
            offeredToolNames,
            deferredToolNames,
          );
        const representedHistoryIds = new Set(
          restored
            ? (restored.historyMessageIds ??
                history.flatMap((message) => {
                  const id = (message as Message & { rakazoMessageId?: string }).rakazoMessageId;
                  return id ? [id] : [];
                }))
            : [
                ...request.history.flatMap((message) => (message.id ? [message.id] : [])),
                ...(request.sourceMessageId ? [request.sourceMessageId] : []),
                ...initialSteering.map((item) => item.messageId),
              ],
        );
        // In a group the person's mid-run messages carry the same label as their history and
        // prompt; the raw text stays what ids and content are matched on.
        const steeringText = (item: AgentSteeringMessage) =>
          !request.promptSpeaker
            ? item.text
            : item.origin === "user"
              ? speakerText(request.promptSpeaker, item.text)
              : neutralizeSpeakerLabels(item.text);
        const promptWithSteering = (
          text: (item: AgentSteeringMessage) => string,
          prompt = request.prompt,
        ) =>
          initialSteering.length
            ? `${prompt}\n\nAdditional user context:\n${initialSteering.map(text).join("\n")}`
            : prompt;
        const initialPrompt = promptWithSteering((item) => item.text);
        const systemPrompt =
          restored?.systemPrompt ??
          (request.instructions ||
            fallbackSystemPrompt(toolDefs.some((tool) => tool.name === "computer_observe")));
        const thinkingLevel = thinkingLevelFor(model, request.model.thinkingLevel);
        let piSession: PiSessionHandle | undefined;
        // Never write an unscoped transcript. Production requests carry userId;
        // callers without an authenticated context simply skip optional recording.
        if (this.sessionRecorder && context?.userId) {
          try {
            piSession = await this.sessionRecorder.start({
              runId: request.runId,
              threadId: request.threadId,
              botId: request.botId,
              userId: context.userId,
              traceId: context?.traceId,
              // A resumed computer-mode turn starts on the computer model.
              provider: host.activeModel.model.provider,
              model: host.activeModel.model.id,
              thinkingLevel: thinkingLevelFor(
                host.activeModel.model,
                host.activeModel.config.thinkingLevel,
              ),
              systemPrompt,
              initialMessages: history.map(withoutSavedMeetingResult),
            });
          } catch (error) {
            getLogger().warn("Pi session recording could not start", {
              runId: request.runId,
              error,
            });
          }
        }

        let contextPolicy = createRuntimeContextPolicy(request, context, {
          credentialScope: apiKey,
          imageTokens: estimatePiImageTokens,
        });
        const contextPolicyFor = (target: RuntimeModelTarget) =>
          createRuntimeContextPolicy({ ...request, model: target.config }, context, {
            credentialScope: target.credentials?.accessToken ?? target.apiKey,
            imageTokens: estimatePiImageTokens,
          });
        let sentContext: { context: Context; sourceLength: number } | undefined;
        const prepareContext = (ctx: Context, m: Model<Api>) => {
          const prepared = contextPolicy.prepareContext(ctx, m);
          // The checkpoint keeps what the policy chose; the opening turn is added to each call.
          sentContext = { context: prepared, sourceLength: ctx.messages.length };
          return withLeadingUser(prepared);
        };
        const usageHooks = {
          prepareContext,
          imageTokens: estimatePiImageTokens,
          recordUsage: request.onUsage,
          onUsage: (usage: AgentUsage) => {
            contextPolicy.onUsage(usage);
            const decision = contextPolicy.getDecision();
            if (decision)
              this.onContextDecision?.({
                ...decision,
                runId: request.runId,
                usage,
              });
          },
        };
        // The idle watchdog may clone a terminal message, preserving its content array. Each
        // failure records whether the provider had accepted that request before it failed.
        const providerFailures = new WeakMap<AssistantMessage["content"], boolean>();
        const rejectedRequests: RejectedProviderRequest[] = [];
        const hasBackups = Boolean(request.fallbackModels?.length);
        let agent: Agent;
        let activeStreamTarget = host.activeModel;
        // A tool result that ended the turn carries the reply the user must still see.
        let terminatedReply: string | undefined;
        // Whether ending now would leave the user nothing: no text shown, no tools run, and the run
        // may not stay silent. Such a run answers with the empty-response text, so an empty model
        // reply is repeated first.
        const wouldEndEmpty = () =>
          !request.allowSilentEmpty && toolCalls === 0 && !streamed.trim();
        let fallbackState: FallbackStreamState = {
          request,
          getActive: () => activeStreamTarget,
          signal,
          isProviderFailure: (message) => providerFailures.has(message.content),
          attempted: new Set<string>(),
          nextIndex: 0,
          backupOutcomes: new Map(),
          selfRecoveries: 0,
          cutReplies: new WeakMap(),
          retriesEmptyReply: wouldEndEmpty,
          stream: (target, ctx, options) => {
            let accepted = false;
            if (hasCurrentImages && !target.model.input.includes("image")) {
              throw new Error(MODEL_IMAGE_INPUT_ERROR);
            }
            return withPiThinkingActivity(
              reliableModelStream(
                target.models,
                target.model,
                ctx,
                withCloudflareAuth(target.config, options),
                target.config.maxTokens,
                () => target.credentials?.accessToken ?? target.apiKey,
                (preparedOptions) =>
                  observedPiStream(
                    target.models,
                    target.model,
                    ctx,
                    preparedOptions,
                    (event) => queue.push(event),
                    target.config.callObserver ?? this.modelCallObserver,
                    {
                      operationKind: request.usageOperationKind ?? "answer",
                      userId: context?.userId,
                      runId: request.runId,
                    },
                    {
                      ...usageHooks,
                      prepareContext,
                      onProviderError: (message) => providerFailures.set(message.content, accepted),
                      onRejectedRequest: (rejection, model) => {
                        accepted = !rejection;
                        if (rejection) {
                          if (rejectedRequests.push(rejection) > MAX_REJECTED_REQUESTS)
                            rejectedRequests.shift();
                          return;
                        }
                        // That model recovered; another model's rejection still explains a failure.
                        for (let index = rejectedRequests.length - 1; index >= 0; index -= 1) {
                          const entry = rejectedRequests[index];
                          if (entry?.provider === model.provider && entry.model === model.id)
                            rejectedRequests.splice(index, 1);
                        }
                      },
                    },
                  ),
                target.config.cacheCapabilities?.retentionMode,
              ),
              setThinking,
            );
          },
          onContextLimit: (contextWindow) => {
            const target = resizeRuntimeTarget(activeStreamTarget, contextWindow);
            activeStreamTarget = target;
            host.activeModel = target;
            host.model = target.model;
            agent.state.model = target.model;
            contextPolicy = contextPolicyFor(target);
          },
          // A throwaway policy, so judging a backup leaves the active policy's sent transcript
          // alone. Cache use is recorded only on usage, which a throwaway never sees. The opening
          // turn is added as on each call, so the backup is judged on what it would be sent.
          prepareForTarget: (target, ctx) => ({
            ...ctx,
            ...withLeadingUser(contextPolicyFor(target).prepareContext(ctx, target.model)),
          }),
          onSwitch: async (target) => {
            await request.onModelChange?.(target.config.provider, target.config.id);
            activeStreamTarget = target;
            contextPolicy = contextPolicyFor(target);
            host.activeModel = target;
            // A backup keeps its own effort.
            const nextThinkingLevel = thinkingLevelFor(
              target.model,
              target.config.thinkingLevel ??
                (sameModelTarget(target.config, request.model)
                  ? request.model.thinkingLevel
                  : undefined),
            );
            agent.state.model = target.model;
            agent.state.thinkingLevel = nextThinkingLevel;
            host.models = target.models;
            host.model = target.model;
            host.apiKey = target.credentials?.accessToken ?? target.apiKey;
          },
        };
        const mainFallbackState = fallbackState;
        const computerFallbackState: FallbackStreamState | undefined = computer
          ? {
              ...fallbackState,
              request: { ...request, model: computer.config, fallbackModels: [] },
              attempted: new Set(),
              backupOutcomes: new Map(),
            }
          : undefined;
        const setTarget = (target: RuntimeModelTarget) => {
          // Keep message origin metadata: Pi's per-provider serializers translate foreign
          // reasoning signatures and tool/result IDs together, including after resume.
          activeStreamTarget = target;
          host.activeModel = target;
          host.models = target.models;
          host.model = target.model;
          host.apiKey = target.credentials?.accessToken ?? target.apiKey;
          contextPolicy = contextPolicyFor(target);
          if (agent) {
            agent.state.model = target.model;
            agent.state.thinkingLevel = thinkingLevelFor(target.model, target.config.thinkingLevel);
          }
        };
        const modeTools = () => {
          if (!computer) return allTools;
          const transition = computerTransitionTool(
            mode,
            async () => {
              const next = mode === "main" ? computer : mainTarget;
              await request.onModelChange?.(
                next.config.provider,
                next.config.id,
                next === computer,
              );
              signal.throwIfAborted();
              if (mode === "main") {
                mainTarget = {
                  ...activeStreamTarget,
                  config: {
                    ...activeStreamTarget.config,
                    thinkingLevel: agent.state.thinkingLevel,
                  },
                };
                mode = "computer";
                computerFrom = agent.state.messages.length;
                fallbackState = computerFallbackState!;
                setTarget(computer);
              } else {
                mode = "main";
                computerSpan = [computerFrom, agent.state.messages.length];
                fallbackState = mainFallbackState;
                setTarget(mainTarget);
              }
              computerMode = {
                version: 1,
                mode,
                main: computerSelection(mainTarget.config),
                computer: computerSelection(computer.config),
              };
              if (mode === "computer")
                fallbackState.messagesBeforeSwitch = agent.state.messages.length;
              tools = modeTools();
              agent.state.tools = tools;
            },
            signal,
          );
          if (
            allTools.some((tool) =>
              ["enter_computer_mode", "leave_computer_mode"].includes(tool.name),
            )
          )
            throw new Error("Computer mode tool name collision");
          return [
            ...allTools.filter(
              (tool) => mode === "computer" || !COMPUTER_MODE_TOOLS.has(tool.label),
            ),
            transition,
          ];
        };
        tools = modeTools();
        if (computer) {
          fallbackState = mode === "computer" ? computerFallbackState! : mainFallbackState;
          setTarget(activeStreamTarget);
          if (savedMode)
            await request.onModelChange?.(
              activeStreamTarget.config.provider,
              activeStreamTarget.config.id,
              mode === "computer",
            );
        }
        const toolCallIds = runToolCallIds(history as Message[], host.providerToolCallIds);
        agent = new Agent({
          sessionId: conversationSessionId(request.threadId, request.botId),
          steeringMode: "all",
          streamFn: (_m, ctx, options) =>
            uniqueToolCallIdStream(
              fallbackAwareModelStream(
                fallbackState,
                ctx,
                withAutomatedLabels({ ...options, fetch: this.modelFetch ?? options?.fetch }),
              ),
              toolCallIds,
            ),
          getApiKey:
            hasBackups || computer
              ? async () => activeStreamTarget.credentials?.accessToken ?? activeStreamTarget.apiKey
              : async () => apiKey,
          finishTurn: async (turn, turnSignal) => {
            let finishedShells: string | undefined;
            await deliverFinishedShells(
              (text) => {
                finishedShells = text;
              },
              host.pendingShells,
              turn,
              turnSignal,
            );
            // Between steps a stopping process hands the turn back, so the next process resumes
            // here instead of repeating a step cut off at the drain limit. A running shell's
            // output would only reach this process, so the turn keeps going until it is read.
            // The hand-back is only a shortcut: when it fails, the turn goes on here as before.
            if (
              request.yieldSignal?.aborted &&
              !handBackFailed &&
              turn.toolResults.length > 0 &&
              !turnSignal?.aborted &&
              !host.pausePending &&
              !terminatedReply &&
              !joinCutReply &&
              host.pendingShells.length === 0
            ) {
              const checkpoint = turnCheckpointAt("");
              if (finishedShells)
                checkpoint.messages.push({
                  role: "user",
                  content: finishedShells,
                  timestamp: Date.now(),
                });
              if (await handBack(serializeTurnCheckpoint(checkpoint))) {
                yielded = true;
                return { action: "end" };
              }
              handBackFailed = true;
            }
            // Steered, so the output reaches the next model request like a tool result. A
            // follow-up waits until the model stops and then costs one model turn each.
            if (finishedShells)
              agent.steer({ role: "user", content: finishedShells, timestamp: Date.now() });
          },
          prepareNextTurnWithContext: async (turn) => {
            const update = computer
              ? {
                  context: {
                    ...turn.context,
                    tools,
                    messages:
                      mode === "main" && computerSpan
                        ? withoutThinkingFrom(turn.context.messages, ...computerSpan)
                        : turn.context.messages,
                  },
                  model: activeStreamTarget.model,
                  thinkingLevel: thinkingLevelFor(
                    activeStreamTarget.model,
                    activeStreamTarget.config.thinkingLevel,
                  ),
                }
              : undefined;
            if (!request.claimSteering) return update;
            // The turn is ending at a terminating result that aborted the agent; no
            // model request would answer a follow-up claimed now, and a completed run
            // deletes its claimed steering. Leave the message queued for the next run.
            if (terminatedReply && !host.pausePending) return update;
            const steering = await request.claimSteering([...seenSteeringIds]);
            if (steering.length === 0) return update;
            seenSteeringIds.push(...steering.map((item) => item.id));
            for (const item of steering) representedHistoryIds.add(item.messageId);
            if (steering.some((item) => item.images?.length && !item.imageFileFallback))
              hasCurrentImages = true;
            const messages = steering.map((item): Message => {
              const images = toPiImages(item.images);
              const text =
                item.origin === "user"
                  ? midTaskMessagePrompt(
                      steeringText(item),
                      toolDefs.some((tool) => tool.name === "message_user"),
                    )
                  : midTaskMessageFromPrompt(steeringText(item), item.origin);
              return {
                role: "user",
                content: images.length ? [{ type: "text", text }, ...images] : text,
                timestamp: Date.now(),
              };
            });
            // Ordered with the turn's other events, so the run can treat it as a turn boundary.
            queue.push({
              type: "steered",
              fromRunUser: steering.some((item) => item.origin === "user"),
            });
            // Returned rather than steered: Pi polls its steering queue once per turn before
            // this hook runs, and skips the poll after it when that one found a message, such
            // as a finished shell's output. Returned messages always go into the next request.
            return { ...update, messages };
          },
          initialState: {
            systemPrompt,
            model: activeStreamTarget.model,
            thinkingLevel: computer
              ? thinkingLevelFor(activeStreamTarget.model, activeStreamTarget.config.thinkingLevel)
              : thinkingLevel,
            tools,
            messages: history,
          },
        });

        let restoringCalls = false;
        // Pi publishes parallel results into state only after the entire batch.
        // Retain completed siblings separately so a pause can include them now.
        const finishedCalls = new Map<string, Message>();
        const turnCheckpointAt = (pendingToolCallId: string) => {
          const messages = sentContext
            ? [
                ...sentContext.context.messages,
                ...agent.state.messages.slice(sentContext.sourceLength),
              ]
            : [...agent.state.messages];
          const assistant = messages.findLast((message) => message.role === "assistant");
          const sequential =
            restoringCalls ||
            (assistant?.role === "assistant" &&
              assistant.content.some(
                (call) =>
                  call.type === "toolCall" &&
                  tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
              ));
          // A turn paused on a question or takeover gets its answer on resume without running
          // the call again, so the count it resumes with already includes that call.
          const answeredOnResume =
            assistant?.role === "assistant" &&
            assistant.content.some(
              (call) =>
                call.type === "toolCall" &&
                call.id === pendingToolCallId &&
                ANSWERED_ON_RESUME.has(call.name),
            );
          const toolCallCount = host.toolCallBudget.count + (answeredOnResume ? 1 : 0);
          return {
            version: 1 as const,
            ...(computerMode
              ? {
                  computerMode: {
                    ...computerMode,
                    main: computerSelection(
                      mode === "main" ? activeStreamTarget.config : mainTarget.config,
                    ),
                  },
                }
              : {}),
            provider: activeStreamTarget.model.provider,
            model: activeStreamTarget.model.id,
            systemPrompt,
            pendingToolCallId,
            ...(toolCallCount > 0 && { toolCallCount }),
            executionMode: sequential ? ("sequential" as const) : ("parallel" as const),
            messages: messages as Message[],
            historyMessageIds: [...representedHistoryIds],
          };
        };
        host.captureCheckpoint = async (toolCallId, executionId) => {
          if (!request.onCheckpoint) return;
          const checkpoint = turnCheckpointAt(toolCallId);
          const { messages } = checkpoint;
          await request.onCheckpoint(() => {
            const unresolved = new Set(unresolvedTurnCheckpointCalls(messages));
            const siblings = messages.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((call) => {
                    if (call.type !== "toolCall" || call.id === toolCallId || !unresolved.has(call))
                      return [];
                    const result = finishedCalls.get(call.id);
                    return result ? [result] : [];
                  })
                : [],
            );
            return serializeTurnCheckpoint({
              ...checkpoint,
              messages: [...checkpoint.messages, ...siblings],
            });
          }, executionId);
        };

        const onAbort = () => {
          agent.abort();
        };
        host.abortTurn = onAbort;
        if (signal.aborted) {
          queue.push({ type: "done", text: "stopped" });
          return;
        }
        signal.addEventListener("abort", onAbort);

        let streamed = "";
        let currentMessageStreamed = "";
        let toolCalls = 0;
        let toolActivityShowing = false;
        let silentToolContinuations = 0;
        // A reply cut off by a dropped connection continues in the same bubble: no turn break,
        // and a continuation that starts by repeating the end of the cut text loses that repeat.
        let joinCutReply: { tail: string; held: string; requested: boolean } | undefined;
        let limitContinuation: { tail: string; start: number } | undefined;
        let outputCutFailed = false;
        // What the last join dropped from the start of a continuation, which the completed
        // message still holds.
        let joinDropped = "";
        const releaseJoin = () => {
          if (!joinCutReply) return;
          const { tail, held, requested } = joinCutReply;
          joinCutReply = undefined;
          joinDropped = held.slice(0, continuationRepeat(tail, held, requested));
          const text = held.slice(joinDropped.length);
          if (!text) return;
          streamed += text;
          queue.push({ type: "text", text });
        };
        let toolWorkPendingFinal = false;
        // Text streamed before this point is tool-turn narration. Only text after
        // it counts as the final reply, including when the completed message omits it.
        let streamedBeforePendingFinal = 0;
        agent.subscribe(async (event) => {
          if (event.type === "tool_execution_end" && isTerminatingReplyResult(event.result)) {
            terminatedReply = terminatingReplyText(event.result) ?? terminatedReply;
          }
          if (event.type === "tool_execution_end" && !event.result.terminate) {
            finishedCalls.set(event.toolCallId, {
              role: "toolResult",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              content: event.result.content,
              details: event.result.details,
              isError: event.isError,
              timestamp: Date.now(),
            });
          }
          if (event.type === "message_end") {
            stopThinking();
            // Before any copy is kept: the recording below, and the checkpoint and provider
            // payloads that reuse this same message object.
            redactAskUserDetailInMessage(event.message, request.secrets);
            await piSession?.appendMessage(withoutSavedMeetingResult(event.message));
          }
          if (event.type === "tool_execution_start") {
            stopThinking();
            finishedCalls.delete(event.toolCallId);
            if (host.toolCallBudget.exceeded) return;
            toolCalls += 1;
            // Live activity feedback: without this the thread shows a bare
            // "working…" for the whole tool call with nothing actionable.
            toolActivityShowing = true;
            queue.push({
              type: "progress",
              text: describeToolActivity(event.toolName, event.args, (name) =>
                toolsByAgentName.get(name),
              ),
              activity: true,
            });
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            host.modelResponses = (host.modelResponses ?? 0) + 1;
            currentMessageStreamed = "";
            // A later assistant turn supersedes a terminating result's carried reply,
            // except the empty aborted message of a turn the result itself ended.
            if (event.message.stopReason !== "aborted") terminatedReply = undefined;
            if (!joinCutReply) joinDropped = "";
            // A later message (after a finished shell or steering, not only a tool call)
            // must not run its text straight on from the previous one.
            if (streamed && !joinCutReply) queue.push({ type: "turn" });
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            const delta = event.assistantMessageEvent.delta;
            if (delta) {
              if (toolActivityShowing) {
                // Real text replaces the activity line instead of appending to it.
                toolActivityShowing = false;
                queue.push({ type: "progress", text: "", activity: true });
              }
              currentMessageStreamed += delta;
              if (joinCutReply) {
                joinCutReply.held += delta;
                const decidable =
                  Math.min(joinCutReply.tail.length, MAX_CONTINUATION_OVERLAP) +
                  MAX_CONTINUATION_MARKER;
                if (joinCutReply.held.length > decidable) releaseJoin();
              } else {
                streamed += delta;
                queue.push({ type: "text", text: delta });
              }
            }
          }
          if (event.type === "turn_end") {
            const messageText =
              event.message.role === "assistant" ? assistantText(event.message) : "";
            const hasToolCalls = messageHasToolCall(event.message);
            const hasToolResults = event.toolResults.length > 0;

            // Text in a turn that also contains a tool call is narration, not a final
            // response. Keep the run alive until a later text-only turn answers the user.
            if (hasToolCalls && hasToolResults && !host.pausePending) {
              toolWorkPendingFinal = true;
              silentToolContinuations = 0;
              streamedBeforePendingFinal = streamed.length;
            } else if (toolWorkPendingFinal && !hasToolCalls && !hasToolResults) {
              const streamedFinal = streamed.slice(streamedBeforePendingFinal).trim();
              if (messageText.trim() || streamedFinal) {
                toolWorkPendingFinal = false;
                silentToolContinuations = 0;
                // A provider can put the answer only on the completed message after
                // narration already filled `streamed`, so message_end will not emit it.
                if (messageText.trim() && !streamedFinal) {
                  streamed += messageText;
                  queue.push({ type: "text", text: messageText });
                }
              } else if (
                // A provider failure is not an empty success. Do not schedule
                // another model turn that would hide the error.
                !providerFailureText(event.message) &&
                !host.pausePending &&
                silentToolContinuations < MAX_SILENT_TOOL_CONTINUATIONS
              ) {
                silentToolContinuations += 1;
                agent.followUp({
                  role: "user",
                  content: request.allowSilentEmpty
                    ? SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT
                    : SILENT_TOOL_CONTINUATION_PROMPT,
                  timestamp: Date.now(),
                });
              }
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const text = assistantText(event.message);
            // The completed text can hold more of a continuation than arrived as deltas, so its
            // repeat of the cut reply is judged on all of it.
            if (
              joinCutReply &&
              !messageHasToolCall(event.message) &&
              text.startsWith(joinCutReply.held)
            ) {
              joinCutReply.held = text;
              currentMessageStreamed = text;
            }
            releaseJoin();
            const streamedThisMessage = currentMessageStreamed;
            currentMessageStreamed = "";
            const continued =
              streamedThisMessage.length > 0 && text.startsWith(streamedThisMessage);
            const textToEmit = continued ? text.slice(streamedThisMessage.length) : text;
            const sincePendingFinal = streamed.slice(streamedBeforePendingFinal);
            const alreadyEmitted =
              !continued &&
              (streamedThisMessage.includes(text) || sincePendingFinal.endsWith(text));
            if (textToEmit && !messageHasToolCall(event.message) && !alreadyEmitted) {
              streamed += textToEmit;
              queue.push({ type: "text", text: textToEmit });
            } else if (text && !streamed) {
              streamed = text;
              queue.push({ type: "text", text });
            }
            let cutBy = fallbackState.cutReplies?.get(event.message.content);
            let tail = text;
            // A normal stop only finishes the cut reply if the join added new text.
            if (
              limitContinuation &&
              !messageHasToolCall(event.message) &&
              event.message.stopReason === "stop" &&
              !streamed.slice(limitContinuation.start).trim() &&
              !cutBy
            ) {
              if (fallbackState.selfRecoveries >= MAX_SELF_RECOVERIES_PER_RUN) {
                outputCutFailed = true;
              } else {
                fallbackState.selfRecoveries += 1;
                cutBy = "limit";
                tail = limitContinuation.tail;
              }
            }
            limitContinuation = undefined;
            if (cutBy) {
              limitContinuation = cutBy === "limit" ? { tail, start: streamed.length } : undefined;
              joinCutReply = { tail, held: "", requested: cutBy === "limit" };
              agent.followUp({
                role: "user",
                content:
                  cutBy === "limit" ? cutReplyAtLimitPrompt(tail) : CUT_REPLY_CONTINUATION_PROMPT,
                timestamp: Date.now(),
              });
            }
          }
        });

        // No "working…" progress push here: the shell already renders its own
        // placeholder while a run is active, and emitting one here shows two.
        const images = toPiImages([
          ...(request.currentTurnImages ?? []),
          ...initialSteering.flatMap((item) => item.images ?? []),
        ]);
        try {
          if (restored) {
            // Complete unresolved calls before another model choice. The executor
            // still enforces canonical approved arguments, routes and idempotency.
            // A terminating result ends the resumed turn like the live one.
            let replayTerminated = false;
            const unresolved = new Set(unresolvedTurnCheckpointCalls(history as Message[]));
            if (restored.executionMode !== "sequential") {
              for (const message of [...history]) {
                if (message.role !== "assistant") continue;
                for (const call of message.content) {
                  if (
                    call.type !== "toolCall" ||
                    !unresolved.has(call) ||
                    call.id === restored.pendingToolCallId
                  )
                    continue;
                  agent.state.messages.push({
                    role: "toolResult",
                    toolCallId: call.id,
                    toolName: call.name,
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify(uncertainEffectResult(call.name, call.arguments)),
                      },
                    ],
                    isError: true,
                    timestamp: Date.now(),
                  });
                  unresolved.delete(call);
                }
              }
            }
            restoringCalls = true;
            for (const message of [...history]) {
              if (message.role !== "assistant") continue;
              for (const call of message.content) {
                if (call.type !== "toolCall" || !unresolved.has(call)) continue;
                const tool = tools.find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error("Pending checkpoint tool is no longer available");
                const interaction =
                  call.id === restored.pendingToolCallId && ANSWERED_ON_RESUME.has(call.name);
                let result: AgentToolResult<JsonValue | undefined>;
                try {
                  signal.throwIfAborted();
                  const args = validateToolArguments(tool, {
                    ...call,
                    arguments: (tool.prepareArguments?.(call.arguments) ??
                      call.arguments) as typeof call.arguments,
                  });
                  result = interaction
                    ? {
                        ...request.resumeToolResult,
                        content: request.resumeToolResult?.content ?? [
                          { type: "text", text: initialPrompt },
                        ],
                        details: undefined,
                      }
                    : await tool.execute(call.id, args, signal);
                } catch (error) {
                  signal.throwIfAborted();
                  result = {
                    content: [
                      {
                        type: "text",
                        text: sanitizeError(error instanceof Error ? error.message : String(error)),
                      },
                    ],
                    details: {},
                    isError: true,
                  };
                }
                agent.state.messages.push({
                  role: "toolResult",
                  toolCallId: call.id,
                  toolName: call.name,
                  content: result.content,
                  details: result.details,
                  isError: result.isError ?? false,
                  timestamp: Date.now(),
                });
                unresolved.delete(call);
                toolCalls += 1;
                await piSession?.appendMessage(
                  withoutSavedMeetingResult(agent.state.messages.at(-1)!),
                );
                if (host.pausePending || isTerminatingReplyResult(result)) {
                  if (!host.pausePending) {
                    // Replay must not run more calls or another model turn after the
                    // result that already ended this turn; its reply is the final one.
                    terminatedReply = terminatingReplyText(result) ?? terminatedReply;
                    replayTerminated = true;
                  }
                  break;
                }
              }
              if (host.pausePending || replayTerminated) break;
            }
            restoringCalls = false;
            if (!host.pausePending && !replayTerminated) {
              const addedHistory = withoutSteeringMessages(request.history, initialSteering).filter(
                (message) => message.id && !representedHistoryIds.has(message.id),
              );
              const replayed = toHistory(
                addedHistory,
                "",
                undefined,
                offeredToolNames,
                deferredToolNames,
              );
              for (const id of runToolCallIds(replayed as Message[]).used) toolCallIds.used.add(id);
              agent.state.messages.push(...replayed);
              for (const message of addedHistory)
                if (message.id) representedHistoryIds.add(message.id);
              for (const item of initialSteering) {
                // Messages this run took up mid-turn stay its steering until it ends, and the
                // saved turn may already hold them.
                if (representedHistoryIds.has(item.messageId)) continue;
                representedHistoryIds.add(item.messageId);
                const images = toPiImages(item.images);
                agent.state.messages.push({
                  role: "user",
                  content: images.length
                    ? [{ type: "text", text: steeringText(item) }, ...images]
                    : steeringText(item),
                  timestamp: Date.now(),
                });
              }
              // A run cannot continue from an assistant message. What trails here is this
              // bot's own earlier reply, which the restored transcript already carries; a
              // continue from its tool results would extend that old reply.
              for (let last = agent.state.messages.at(-1); isHistoryReply(last); ) {
                agent.state.messages.pop();
                last = agent.state.messages.at(-1);
              }
              toolWorkPendingFinal = true;
              await agent.continue();
            }
          } else {
            // Only the person's messages go under their label; anyone else's is framed by origin.
            await agent.prompt(
              promptWithSteering(
                (item) =>
                  item.origin === "user"
                    ? steeringText(item)
                    : midTaskMessageFromPrompt(steeringText(item), item.origin),
                request.promptSpeaker
                  ? speakerText(request.promptSpeaker, request.prompt)
                  : request.prompt,
              ),
              images?.length ? images : undefined,
            );
          }
        } finally {
          try {
            await agent.waitForIdle();
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
        }
        // A continuation that failed or stopped early still hands over what it wrote.
        releaseJoin();
        if (yielded) return;

        // Budget abort stops the agent underneath the model, which leaves
        // errorMessage set. Treat that as a soft stop so the turn still ends
        // with a durable assistant message instead of a failed run.
        const budgetExceeded = host.toolCallBudget.exceeded;
        const terminalMessage = agent.state.messages.at(-1);
        // pi-agent-core records provider failures as an empty assistant message and
        // still resolves the run; state.errorMessage misses length stops and failures
        // that never landed on state.
        const providerFailure =
          !budgetExceeded && terminalMessage ? providerFailureText(terminalMessage) : undefined;
        const error = outputCutFailed
          ? MODEL_OUTPUT_CUT_ERROR
          : agent.state.errorMessage || providerFailure;
        // A turn ended at a terminating tool result leaves the abort's message on the
        // agent; the reply that result carries is the answer, not a failure.
        const endedAtToolResult = Boolean(terminatedReply) && !host.pausePending && !signal.aborted;
        if (
          error &&
          !budgetExceeded &&
          !endedAtToolResult &&
          (!host.pausePending || signal.aborted)
        ) {
          let message = sanitizeProviderError(activeStreamTarget.model.provider, error);
          if (
            !signal.aborted &&
            terminalMessage?.role === "assistant" &&
            terminalMessage.stopReason !== "aborted" &&
            fallbackState.primaryFailure &&
            fallbackState.nextIndex >= (request.fallbackModels?.length ?? 0) &&
            fallbackState.backupOutcomes.size > 0 &&
            (request.fallbackModels ?? []).every(
              (choice) =>
                sameModelTarget(choice, request.model) ||
                fallbackState.backupOutcomes.has(modelTargetKey(choice)),
            )
          ) {
            message = modelFallbackFailure(fallbackState.primaryFailure, [
              ...fallbackState.backupOutcomes.values(),
            ]);
          }
          const failure = modelFailure(error, message, {
            provider: activeStreamTarget.config.provider,
            primaryProvider: fallbackState.request.model.provider,
            failedAfterAccepting:
              terminalMessage?.role === "assistant" &&
              providerFailures.get(terminalMessage.content) === true,
          });
          // Only a rejection nothing explains needs its request's shape to be reproduced.
          throw failure.constructor === Error
            ? attachRejectedRequests(failure, rejectedRequests)
            : failure;
        }
        // Only an assistant message can hold the answer a provider left off the deltas;
        // a trailing tool result is tool output, not the model's reply.
        if (
          !budgetExceeded &&
          terminalMessage?.role === "assistant" &&
          !messageHasToolCall(terminalMessage)
        ) {
          const completedText = assistantText(terminalMessage);
          const terminalText =
            joinDropped && completedText.startsWith(joinDropped)
              ? completedText.slice(joinDropped.length)
              : completedText;
          const sincePendingFinal = streamed.slice(streamedBeforePendingFinal);
          if (terminalText.trim() && !sincePendingFinal.includes(terminalText)) {
            const missing =
              sincePendingFinal && terminalText.startsWith(sincePendingFinal)
                ? terminalText.slice(sincePendingFinal.length)
                : terminalText;
            if (missing) {
              queue.push({ type: "text", text: missing });
              streamed += missing;
              toolWorkPendingFinal = false;
            }
          }
        }
        if (budgetExceeded) {
          const budgetMessage = toolCallBudgetExceededMessage(host.toolCallBudget.limit);
          if (streamed.trim()) {
            const suffix = `\n\n${budgetMessage}`;
            queue.push({ type: "text", text: suffix });
            streamed += suffix;
          } else {
            queue.push({ type: "text", text: budgetMessage });
            streamed = budgetMessage;
          }
        } else if (terminatedReply && !host.pausePending) {
          // The turn ended at a terminating tool result; its reply is the final answer.
          if (streamed.trim()) {
            const suffix = `\n\n${terminatedReply}`;
            queue.push({ type: "text", text: suffix });
            streamed += suffix;
          } else {
            queue.push({ type: "text", text: terminatedReply });
            streamed = terminatedReply;
          }
        } else if (!host.pausePending && toolWorkPendingFinal) {
          if (request.allowSilentEmpty) {
            // Scheduled/FYI runs may finish after tools with no user-visible text.
            streamed = "";
          } else {
            throw new ModelOutputError(MISSING_TOOL_FINAL_RESPONSE_ERROR);
          }
        } else if (!streamed.trim() && !host.pausePending) {
          streamed = "";
          const lastMessage = agent.state.messages.at(-1);
          const fallback = lastMessage?.role === "assistant" ? assistantText(lastMessage) : "";
          if (fallback.trim()) {
            queue.push({ type: "text", text: fallback });
            streamed = fallback;
          } else if (toolWorkPendingFinal && !request.allowSilentEmpty) {
            throw new ModelOutputError(MISSING_TOOL_FINAL_RESPONSE_ERROR);
          } else if (wouldEndEmpty()) {
            streamed = request.emptyResponseText?.trim() || "No response. Try again.";
            queue.push({ type: "text", text: streamed });
          }
        }
        queue.push(streamed.trim() ? { type: "done", text: streamed } : { type: "done" });
      } catch (error) {
        span?.setStatus({ status: "error" });
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        queue.fail(
          error instanceof TransientModelError
            ? new TransientModelError(message)
            : error instanceof ModelAccountError
              ? new ModelAccountError(message)
              : error instanceof ModelOutputError
                ? new ModelOutputError(message)
                : attachRejectedRequests(new Error(message), rejectedRequestsOf(error) ?? []),
        );
      } finally {
        stopThinking();
        signal.removeEventListener("abort", stopThinking);
        queue.close();
        if (trackedBudget) {
          const keepForResume =
            (signal.aborted || Boolean(resumeHost?.pausePending) || yielded) &&
            !trackedBudget.exceeded;
          releaseToolCallBudget(request.runId, keepForResume);
        }
      }
    });
    const active = { controller, work };
    running.set(request.runId, active);

    try {
      yield* queue.iterate();
    } finally {
      controller.abort();
      await work;
      if (running.get(request.runId) === active) running.delete(request.runId);
    }
  }
}
