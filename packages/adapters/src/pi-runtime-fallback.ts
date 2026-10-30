import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ModelsSimpleStreamOptions,
  ModelThinkingLevel,
  ThinkingLevelMap,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import {
  isModelCredentialRejected,
  isRetryableProviderUnavailable,
  isTransientModelError,
} from "@rakazo/adapter-kit";
import type { ModelBackupOutcome } from "@rakazo/core";
import {
  abortableDelay,
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_OUTPUT_CUT_ERROR,
  MODEL_OUTPUT_LIMIT_ERROR,
  MODEL_REQUEST_LIMIT_ERROR,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { ModelImageLimitError, pruneForRebuild } from "./context-pruning.js";
import { groqRequestContextWindow } from "./groq-request-budget.js";
import { estimateModelContextTokens } from "./model-context.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import { affordableOpenRouterOutput } from "./openrouter-output-budget.js";
import { estimatePiImageTokens } from "./pi-image-context.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { assistantText, messageHasToolCall, sanitizeProviderError } from "./pi-runtime-errors.js";
import {
  effectiveOutputReserve,
  MODEL_STREAM_TIMEOUT_MS,
  resolveCompletionMaxTokens,
} from "./pi-runtime-limits.js";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import {
  acceptedReasoningEfforts,
  cardOutputCeiling,
  modelForCompletion,
  modelTargetKey,
  resolveRuntimeModel,
  sameModelTarget,
  thinkingLevelFor,
  withOutputBudget,
} from "./pi-runtime-models.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MESSAGE } from "./pi-runtime-stream.js";
import { reportedContextWindow } from "./reported-context-window.js";
import {
  isThinkingSignatureMismatch,
  withoutThinkingBlocks,
  withoutThinkingFrom,
} from "./thinking-signatures.js";

const MODEL_PROVIDER_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;

/** Why a reply ended before the model finished it. */
export type CutReplyReason = "connection" | "limit";

export interface FallbackStreamState {
  request: AgentRunRequest;
  getActive(): RuntimeModelTarget;
  signal: AbortSignal;
  attempted: Set<string>;
  nextIndex: number;
  primaryFailure?: string;
  backupOutcomes: Map<string, ModelBackupOutcome>;
  /** Calls repeated, given more room or continued after a cut; bounded per run. */
  selfRecoveries: number;
  /** More room for the next call, after a call ran out of it inside a tool call. */
  nextCallRecovery?: { maxTokens?: number; thinkingLevel?: ModelThinkingLevel };
  /**
   * Replies ended early by a dropped connection or the output limit; the runtime asks the model
   * to continue them. Absent where nothing asks (subagents), so a cut there is not continued.
   */
  cutReplies?: WeakMap<AssistantMessage["content"], CutReplyReason>;
  /** The next call continues a cut reply, so a dropped connection there is not continued again. */
  continuingCutReply?: boolean;
  onSwitch(target: RuntimeModelTarget): Promise<void>;
  onContextLimit(contextWindow: number): void;
  isProviderFailure(message: AssistantMessage): boolean;
  /** Set once a provider rejected replayed thinking signatures; see thinking-signatures.ts. */
  dropThinkingBlocks?: boolean;
  /** Output reservations reduced by a rejected request, scoped to this run and model. */
  outputCaps?: Map<string, number>;
  /** Thinking levels narrowed to the reasoning efforts an endpoint accepts, scoped to this run and connection. */
  thinkingLevelMaps?: Map<string, ThinkingLevelMap>;
  /**
   * Messages written before the last switch to a backup model. Their thinking is bound to the
   * model and transcript it was written for, and the backup's policy starts with a rebuild that
   * can rewrite earlier messages, so requests leave that thinking out from the switch on.
   */
  messagesBeforeSwitch?: number;
  stream(
    target: RuntimeModelTarget,
    context: TranscriptContext,
    options: ModelsSimpleStreamOptions | undefined,
  ): AssistantMessageEventStream;
}

/**
 * Reply text or a tool call. Thinking alone is never shown or run, so a call that has only
 * thought can be retried from scratch with its thinking discarded.
 */
function assistantHasVisibleOutput(message: AssistantMessage): boolean {
  return message.content.some(
    (part) => part.type === "toolCall" || (part.type === "text" && part.text.length > 0),
  );
}

function eventHasVisibleOutput(event: AssistantMessageEvent): boolean {
  if (event.type === "toolcall_start" || event.type === "toolcall_end") return true;
  if (event.type === "text_delta" || event.type === "toolcall_delta") {
    if (event.delta.length > 0) return true;
  }
  if (event.type === "text_end" && event.content.length > 0) return true;
  if (event.type === "done") return assistantHasVisibleOutput(event.message);
  if (event.type === "error") return assistantHasVisibleOutput(event.error);
  return assistantHasVisibleOutput(event.partial);
}

export const MAX_SELF_RECOVERIES_PER_RUN = 3;
const MIN_CONTINUATION_OVERLAP = 4;
export const MAX_CONTINUATION_OVERLAP = 240;

/**
 * How much of the start of a continuation repeats the end of the cut reply: the longest such
 * run of at least a few characters, up to about a sentence. Shorter matches are coincidence.
 */
export function continuationOverlap(
  cut: string,
  continuation: string,
  minimum = MIN_CONTINUATION_OVERLAP,
): number {
  const longest = Math.min(cut.length, continuation.length, MAX_CONTINUATION_OVERLAP);
  for (let size = longest; size >= minimum; size -= 1) {
    if (cut.endsWith(continuation.slice(0, size))) return size;
  }
  return 0;
}

// Models often open a continuation with an ellipsis before picking the words up again.
const CONTINUATION_MARKER = /^(?:…|\.{3})[^\S\n]*/;
/** Longest marker the join may drop, so it waits for enough text to decide. */
export const MAX_CONTINUATION_MARKER = 4;

/**
 * How much of the start of a continuation to drop: its repeat of the end of the cut reply, and
 * an ellipsis before that repeat. An ellipsis that doesn't lead into a repeat is kept.
 */
export function continuationRepeat(cut: string, continuation: string, requested = false): number {
  if (requested) cut = cut.trimEnd();
  // Short requested repeats must cover the whole final word or cut fragment.
  const minimum = requested
    ? Math.min(MIN_CONTINUATION_OVERLAP, /\S+$/.exec(cut)?.[0].length ?? MIN_CONTINUATION_OVERLAP)
    : MIN_CONTINUATION_OVERLAP;
  const marker = CONTINUATION_MARKER.exec(continuation)?.[0] ?? "";
  const afterMarker = marker
    ? continuationOverlap(cut, continuation.slice(marker.length), minimum)
    : 0;
  return afterMarker
    ? marker.length + afterMarker
    : continuationOverlap(cut, continuation, minimum);
}
const LOWEST_FIRST_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * A call that spent its whole output budget before writing anything gets one more try with
 * more room: double the budget within the model's ceiling, the input reserve and any output cap
 * the provider asked for, or, when the user set the budget or it is already at that ceiling,
 * one thinking level less (never off, which some endpoints refuse).
 */
function lengthRecovery(
  target: RuntimeModelTarget,
  sentMaxTokens: number,
  thinkingLevel: ModelThinkingLevel,
  outputCap?: number,
): { maxTokens?: number; thinkingLevel?: ModelThinkingLevel } | undefined {
  if (target.config.maxTokens === undefined) {
    const doubled = Math.min(
      target.cardMaxTokens ?? Number.POSITIVE_INFINITY,
      outputCap ?? Number.POSITIVE_INFINITY,
      sentMaxTokens * 2,
    );
    const maxTokens = target.model.contextWindow
      ? effectiveOutputReserve(target.model.contextWindow, doubled)
      : doubled;
    if (Number.isFinite(maxTokens) && maxTokens > sentMaxTokens) return { maxTokens };
  }
  if (thinkingLevel === "off") return undefined;
  const supported = getSupportedThinkingLevels(target.model);
  const lower = LOWEST_FIRST_THINKING_LEVELS.slice(
    0,
    LOWEST_FIRST_THINKING_LEVELS.indexOf(thinkingLevel),
  ).findLast((level) => supported.includes(level));
  return lower ? { thinkingLevel: lower } : undefined;
}

function contextImageCount(context: Context): number {
  return context.messages.reduce((total, message) => {
    if (!("content" in message) || !Array.isArray(message.content)) return total;
    return total + message.content.filter((part) => part.type === "image").length;
  }, 0);
}

/**
 * Same rule as the primary model (modelAcceptsImageInput): the catalog's input
 * modalities decide for native providers, and the connection's acceptsImages flag
 * only applies to OpenAI-compatible models, whose runtime model is built from it.
 */
function fallbackSeesImages(candidate: RuntimeModelTarget): boolean {
  if (!candidate.model.input.includes("image")) return false;
  return (
    candidate.config.provider !== OPENAI_COMPATIBLE_PROVIDER_ID ||
    candidate.config.acceptsImages !== false
  );
}

function fallbackIncompatibility(
  candidate: RuntimeModelTarget,
  context: TranscriptContext,
  options: ModelsSimpleStreamOptions | undefined,
  tools: readonly ConnectorTool[],
): string | undefined {
  // The backup's own context policy prunes on its first call; judge what it would send. Too
  // many user images for its limit throws, and the caller skips the backup.
  try {
    context = {
      ...context,
      messages: pruneForRebuild(context.messages, candidate.config.maxImagesPerPrompt),
    };
  } catch (error) {
    if (error instanceof ModelImageLimitError)
      return "The request exceeds the backup model's image limit.";
    throw error;
  }
  const inputTokens = estimateModelContextTokens(context, estimatePiImageTokens);
  const outputTokens = resolveCompletionMaxTokens(
    candidate.model.maxTokens,
    candidate.config.maxTokens,
    options?.maxTokens,
    candidate.model.reasoning,
    candidate.model.contextWindow,
  );
  // Token counts are estimates and can differ by provider/tokenizer. Reserve a
  // small input-relative margin, not a fixed 4096 tokens that would exclude
  // otherwise usable small-context models on short turns.
  const contextSafetyMargin = Math.max(256, Math.ceil(inputTokens * 0.1));
  if (candidate.model.contextWindow <= inputTokens + outputTokens + contextSafetyMargin)
    return "Conversation exceeds the backup model's context limit.";
  const imageCount = contextImageCount(context);
  if (
    (imageCount > 0 || tools.some((tool) => IMAGE_RETURNING_COMPUTER_TOOLS.has(tool.name))) &&
    !fallbackSeesImages(candidate)
  ) {
    return "The backup model cannot use the images required by this request.";
  }
  if (
    typeof candidate.config.maxImagesPerPrompt === "number" &&
    imageCount > candidate.config.maxImagesPerPrompt
  ) {
    return "The request exceeds the backup model's image limit.";
  }
  // The primary's thinking level does not count: a backup without reasoning runs with thinking off.
  const requiresReasoning = Boolean(
    candidate.config.thinkingLevel && candidate.config.thinkingLevel !== "off",
  );
  return requiresReasoning && !candidate.model.reasoning
    ? "The backup model does not support the requested thinking level."
    : undefined;
}

export function fallbackAwareModelStream(
  state: FallbackStreamState,
  context: TranscriptContext,
  options: ModelsSimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const output = new AssistantMessageEventStream();
  let lastPartial: AssistantMessage | undefined;
  const signal = options?.signal ? AbortSignal.any([state.signal, options.signal]) : state.signal;
  // Once a signature is rejected, requests omit those thinking blocks. Backup fit
  // must use that same context, or a usable backup can be skipped on discarded text.
  // A backup is judged on the context it would get after the switch, without earlier thinking.
  const requestContext = (switching = false) => {
    if (state.dropThinkingBlocks) return withoutThinkingBlocks(context);
    const before = switching ? context.messages.length : state.messagesBeforeSwitch;
    if (!before) return context;
    const messages = withoutThinkingFrom(context.messages, 0, before);
    return messages === context.messages ? context : { ...context, messages };
  };
  const signalAborted = () => signal.aborted;
  const recordFailure = (target: RuntimeModelTarget, error: string) => {
    if (sameModelTarget(target.config, state.request.model)) return;
    state.backupOutcomes.set(modelTargetKey(target.config), {
      provider: target.config.provider,
      modelId: target.config.id,
      status: "failed",
      reason: sanitizeProviderError(target.config.provider, error),
    });
  };
  const finishWithThrownError = (target: RuntimeModelTarget, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(target, message);
    const aborted = signalAborted() || /abort|cancel/i.test(message);
    const stopReason: "aborted" | "error" = aborted ? "aborted" : "error";
    const failure: AssistantMessage = {
      role: "assistant",
      content: lastPartial?.content ?? [],
      api: target.model.api,
      provider: target.model.provider,
      model: target.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      errorMessage: message,
      timestamp: Date.now(),
    };
    output.push({ type: "error", reason: stopReason, error: failure });
    output.end(failure);
  };
  const failIfAborted = (target: RuntimeModelTarget) => {
    if (!signalAborted()) return false;
    finishWithThrownError(target, new Error("Model request was aborted"));
    return true;
  };
  const resolveNext = async (
    current: RuntimeModelTarget,
  ): Promise<RuntimeModelTarget | undefined> => {
    const choices = state.request.fallbackModels ?? [];
    while (state.nextIndex < choices.length && !signalAborted()) {
      const choice = choices[state.nextIndex++];
      if (!choice) continue;
      const key = modelTargetKey(choice);
      if (state.attempted.has(key)) continue;
      state.attempted.add(key);
      if (sameModelTarget(choice, current.config)) continue;
      const skip = (reason: string) =>
        state.backupOutcomes.set(key, {
          provider: choice.provider,
          modelId: choice.id,
          status: "skipped",
          reason,
        });
      try {
        const config = state.request.resolveFallbackModel
          ? await state.request.resolveFallbackModel(
              choice.provider,
              choice.id,
              choice.connectionId,
            )
          : (choice as AgentRunRequest["model"]);
        if (signalAborted()) return undefined;
        if (config.provider !== choice.provider || config.id !== choice.id) {
          skip("The saved backup connection no longer matches this model.");
          continue;
        }
        // Never borrow the primary or process-wide key for a backup. Production resolves
        // each candidate lazily from the authenticated user's Space-scoped credential store.
        if (!config.apiKey && !config.oauth && config.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
          skip("No credential is available for the backup model.");
          continue;
        }
        const resolved = resolveRuntimeModel(config);
        if (
          !resolved.model ||
          resolved.model.provider !== config.provider ||
          resolved.model.id !== config.id
        ) {
          skip("The backup model is unavailable.");
          continue;
        }
        const candidate: RuntimeModelTarget = {
          config,
          models: resolved.models,
          model: modelForCompletion(resolved.model, config.maxTokens),
          cardMaxTokens: cardOutputCeiling(resolved.model),
          apiKey: resolved.apiKey,
          credentials: resolved.credentials,
        };
        const incompatibility = fallbackIncompatibility(
          candidate,
          requestContext(true),
          options,
          state.request.tools,
        );
        if (incompatibility) {
          skip(incompatibility);
          continue;
        }
        return candidate;
      } catch {
        // Do not persist credential-resolution diagnostics; they can contain secrets.
        skip("The backup connection or request could not be prepared.");
      }
    }
    return undefined;
  };
  const run = async () => {
    let buffered: AssistantMessageEvent[] = [];
    let retries = 0;
    let recoveredIdle = false;
    let sizingFailure: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
    // Bound same-model retries. Explicit backups retain their per-model header
    // timeout: a post-header idle watchdog can already exceed that timeout.
    let startedAt = Date.now();
    const timeoutMs = options?.timeoutMs ?? MODEL_STREAM_TIMEOUT_MS;
    let firstRetryableError: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
    // Set once this call has been repeated after spending its output budget on nothing visible.
    let lengthRecovered = false;
    let outputBudget = state.nextCallRecovery?.maxTokens;
    let thinkingOverride = state.nextCallRecovery?.thinkingLevel;
    state.nextCallRecovery = undefined;
    const continuingCutReply = Boolean(state.continuingCutReply);
    state.continuingCutReply = false;
    while (!signalAborted()) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const failure = firstRetryableError ?? sizingFailure;
      if ((retries > 0 || sizingFailure) && remainingMs <= 0 && failure) {
        output.push(failure);
        output.end(failure.error);
        return;
      }
      const active = state.getActive();
      const targetKey = JSON.stringify([active.config.provider, active.config.id]);
      const connectionKey = modelTargetKey(active.config);
      const thinkingLevelMap = state.thinkingLevelMaps?.get(connectionKey);
      const target = thinkingLevelMap
        ? { ...active, model: { ...active.model, thinkingLevelMap } }
        : active;
      const outputCap = state.outputCaps?.get(targetKey);
      const attemptOptions = {
        ...options,
        ...(retries > 0 || sizingFailure ? { timeoutMs: remainingMs } : {}),
        ...(outputCap !== undefined
          ? { maxTokens: Math.min(outputCap, options?.maxTokens ?? outputCap) }
          : {}),
      };
      lastPartial = undefined;
      let sawVisibleOutput = false;
      let restart = false;
      let stream: AssistantMessageEventStream;
      const thinkingLevel =
        thinkingOverride ??
        (target.model.reasoning
          ? thinkingLevelFor(
              target.model,
              target.config.thinkingLevel ??
                options?.reasoning ??
                state.request.model.thinkingLevel,
            )
          : "off");
      const sentTarget = outputBudget ? withOutputBudget(target, outputBudget) : target;
      const sentMaxTokens = resolveCompletionMaxTokens(
        sentTarget.model.maxTokens,
        sentTarget.config.maxTokens,
        attemptOptions.maxTokens,
        sentTarget.model.reasoning,
        sentTarget.model.contextWindow,
      );
      try {
        const apiKey = target.credentials?.accessToken ?? target.apiKey;
        const reasoning = thinkingLevel === "off" ? undefined : thinkingLevel;
        stream = state.stream(
          sentTarget,
          requestContext(),
          // With backups the switch replaces the SDK's retry, so a hung model is not waited on twice.
          state.request.fallbackModels?.length
            ? { ...attemptOptions, apiKey, reasoning, maxRetries: 0 }
            : thinkingOverride
              ? { ...attemptOptions, reasoning }
              : attemptOptions,
        );
      } catch (error) {
        finishWithThrownError(target, error);
        return;
      }
      try {
        for await (const event of stream) {
          if (event.type === "error") {
            recordFailure(target, event.error.errorMessage ?? "Model request failed.");
            let terminalEvent = event;
            let requestLimitTooSmall = false;
            const hasTerminalVisibleOutput = assistantHasVisibleOutput(event.error);
            if (
              !sawVisibleOutput &&
              !hasTerminalVisibleOutput &&
              event.reason === "error" &&
              !signalAborted() &&
              !sizingFailure &&
              state.isProviderFailure(event.error)
            ) {
              const requestWindow = groqRequestContextWindow(
                target.config.provider,
                event.error.errorMessage,
                target.model.contextWindow,
              );
              const contextWindow =
                requestWindow ??
                reportedContextWindow(
                  target.config.provider,
                  event.error.errorMessage,
                  target.model.contextWindow,
                );
              if (contextWindow !== undefined && Date.now() - startedAt < timeoutMs) {
                const requiredContext = requestContext();
                const minimumInput = estimateModelContextTokens({
                  ...requiredContext,
                  messages: requiredContext.messages.filter((message) => message.role === "system"),
                });
                const outputReserve = effectiveOutputReserve(contextWindow, sentMaxTokens);
                requestLimitTooSmall = minimumInput >= contextWindow - outputReserve;
                getLogger().info(
                  requestLimitTooSmall
                    ? "model.context_limit.refused"
                    : "model.context_limit.reduced",
                  {
                    runId: state.request.runId,
                    provider: target.config.provider,
                    model: target.config.id,
                    contextWindow,
                  },
                );
                if (requestLimitTooSmall) {
                  const limitError =
                    requestWindow === undefined
                      ? MODEL_CONTEXT_TOO_SMALL_ERROR
                      : MODEL_REQUEST_LIMIT_ERROR;
                  terminalEvent = { ...event, error: { ...event.error, errorMessage: limitError } };
                  recordFailure(target, limitError);
                } else {
                  state.onContextLimit(contextWindow);
                  sizingFailure = event;
                  buffered = [];
                  restart = true;
                  break;
                }
              }
              const affordable = affordableOpenRouterOutput(
                target.config.provider,
                event.error.errorMessage,
                sentMaxTokens,
              );
              if (affordable !== undefined && Date.now() - startedAt < timeoutMs) {
                state.outputCaps ??= new Map();
                state.outputCaps.set(targetKey, affordable);
                getLogger().info("model.output_reservation.reduced", {
                  runId: state.request.runId,
                  provider: target.config.provider,
                  model: target.config.id,
                  requestedMaxTokens: sentMaxTokens,
                  effectiveMaxTokens: affordable,
                });
                sizingFailure = event;
                buffered = [];
                restart = true;
                break;
              }
            }
            const narrowedThinking =
              !sawVisibleOutput &&
              !hasTerminalVisibleOutput &&
              event.reason === "error" &&
              !signalAborted() &&
              !thinkingLevelMap
                ? acceptedReasoningEfforts(target.model, event.error.errorMessage)
                : undefined;
            if (narrowedThinking) {
              state.thinkingLevelMaps ??= new Map();
              state.thinkingLevelMaps.set(connectionKey, narrowedThinking);
              buffered = [];
              restart = true;
              break;
            }
            if (
              !sawVisibleOutput &&
              !hasTerminalVisibleOutput &&
              event.reason === "error" &&
              !signalAborted() &&
              !state.dropThinkingBlocks &&
              isThinkingSignatureMismatch(event.error.errorMessage)
            ) {
              // Later calls in this run skip the stale thinking up front instead of failing first.
              state.dropThinkingBlocks = true;
              buffered = [];
              restart = true;
              break;
            }
            if (
              !sawVisibleOutput &&
              !hasTerminalVisibleOutput &&
              event.reason === "error" &&
              !signalAborted() &&
              state.isProviderFailure(event.error) &&
              (requestLimitTooSmall ||
                isRetryableProviderUnavailable(event.error) ||
                isModelCredentialRejected(event.error))
            ) {
              state.primaryFailure ??= sanitizeProviderError(
                target.config.provider,
                terminalEvent.error.errorMessage ?? "Model request failed.",
              );
              const next = await resolveNext(target);
              if (failIfAborted(target)) return;
              if (next) {
                state.messagesBeforeSwitch = context.messages.length;
                await state.onSwitch(next);
                if (failIfAborted(target)) return;
                // A raised budget or lower thinking level fitted the failed model, not this one.
                outputBudget = undefined;
                thinkingOverride = undefined;
                buffered = [];
                restart = true;
                break;
              }
              // An exhausted quota, usage window or rejected credential can move to a backup
              // but will not clear within the retry budget, so only transient failures retry the same model.
              if (isTransientModelError(event.error)) {
                firstRetryableError ??= event;
                const idle = event.error.errorMessage === MODEL_STREAM_IDLE_TIMEOUT_MESSAGE;
                const delay = idle
                  ? recoveredIdle
                    ? undefined
                    : MODEL_PROVIDER_RETRY_DELAYS_MS[0]
                  : MODEL_PROVIDER_RETRY_DELAYS_MS[retries];
                if (idle && delay !== undefined) {
                  // The post-header idle bound can outlast the header retry window.
                  // Renew it once for this empty call, retaining completed tool results.
                  recoveredIdle = true;
                  startedAt = Date.now();
                }
                // Ordinary failures and backoff share the remaining retry window.
                if (delay !== undefined && Date.now() - startedAt + delay < timeoutMs) {
                  retries += 1;
                  await abortableDelay(delay, signal);
                  if (failIfAborted(target)) return;
                  if (Date.now() - startedAt < timeoutMs) {
                    buffered = [];
                    restart = true;
                    break;
                  }
                }
                terminalEvent = firstRetryableError;
              }
            }
            const cutText = lastPartial ? assistantText(lastPartial) : "";
            if (
              state.cutReplies &&
              sawVisibleOutput &&
              lastPartial &&
              cutText &&
              !continuingCutReply &&
              !messageHasToolCall(lastPartial) &&
              event.reason === "error" &&
              !signalAborted() &&
              state.selfRecoveries < MAX_SELF_RECOVERIES_PER_RUN &&
              isTransientModelError(event.error)
            ) {
              // End the call with the text the user already sees; the runtime asks for the rest.
              // The terminal message can hold text that never arrived as a delta.
              const { errorMessage: _dropped, ...ended } = event.error;
              const cut: AssistantMessage = {
                ...ended,
                content: (assistantText(event.error) ? event.error : lastPartial).content.filter(
                  (part) => part.type === "text",
                ),
                stopReason: "stop",
              };
              state.selfRecoveries += 1;
              state.cutReplies.set(cut.content, "connection");
              state.continuingCutReply = true;
              for (const pending of buffered) output.push(pending);
              buffered = [];
              output.push({ type: "done", reason: "stop", message: cut });
              output.end(cut);
              return;
            }
            for (const pending of buffered) output.push(pending);
            buffered = [];
            const terminal =
              sawVisibleOutput && event.error.content.length === 0 && lastPartial
                ? { ...event, error: { ...event.error, content: lastPartial.content } }
                : terminalEvent;
            output.push(terminal);
            output.end(terminal.error);
            return;
          }
          if (event.type === "done") {
            // A recovered call must not replace a later failure with its old error.
            state.primaryFailure = undefined;
            state.backupOutcomes.delete(targetKey);
            if (
              event.message.stopReason === "length" &&
              !event.message.errorMessage &&
              messageHasToolCall(event.message)
            ) {
              // pi fails a tool call cut at the limit and asks for it again. That re-issue gets
              // more room; once the run's recoveries are spent, the run fails instead of looping.
              if (state.selfRecoveries >= MAX_SELF_RECOVERIES_PER_RUN) {
                const failure: AssistantMessage = {
                  ...event.message,
                  content: event.message.content.filter((part) => part.type !== "toolCall"),
                  stopReason: "error",
                  errorMessage: assistantText(event.message).trim()
                    ? MODEL_OUTPUT_CUT_ERROR
                    : MODEL_OUTPUT_LIMIT_ERROR,
                };
                for (const pending of buffered) output.push(pending);
                buffered = [];
                output.push({ type: "error", reason: "error", error: failure });
                output.end(failure);
                return;
              }
              state.selfRecoveries += 1;
              state.nextCallRecovery = lengthRecovery(
                target,
                sentMaxTokens,
                thinkingLevel,
                outputCap,
              );
            }
            if (
              state.cutReplies &&
              event.message.stopReason === "length" &&
              !event.message.errorMessage &&
              !messageHasToolCall(event.message) &&
              assistantText(event.message).trim() &&
              !signalAborted()
            ) {
              // A reply that ran out of room mid-way is not an answer. It is continued in a call
              // with more room, again if the continuation runs out too, while the run has
              // recoveries left; after that the run fails and keeps the text written so far.
              const ended: AssistantMessage = {
                ...event.message,
                content: event.message.content.filter((part) => part.type === "text"),
              };
              const message: AssistantMessage =
                state.selfRecoveries >= MAX_SELF_RECOVERIES_PER_RUN
                  ? { ...ended, stopReason: "error", errorMessage: MODEL_OUTPUT_CUT_ERROR }
                  : { ...ended, stopReason: "stop" };
              if (message.stopReason === "stop") {
                state.selfRecoveries += 1;
                state.cutReplies.set(message.content, "limit");
                state.continuingCutReply = true;
                state.nextCallRecovery = lengthRecovery(
                  target,
                  sentMaxTokens,
                  thinkingLevel,
                  outputCap,
                );
              }
              for (const pending of buffered) output.push(pending);
              buffered = [];
              output.push(
                message.stopReason === "stop"
                  ? { type: "done", reason: "stop", message }
                  : { type: "error", reason: "error", error: message },
              );
              output.end(message);
              return;
            }
            const recovery =
              !lengthRecovered &&
              event.message.stopReason === "length" &&
              !event.message.errorMessage &&
              !assistantHasVisibleOutput(event.message) &&
              state.selfRecoveries < MAX_SELF_RECOVERIES_PER_RUN &&
              !signalAborted()
                ? lengthRecovery(target, sentMaxTokens, thinkingLevel, outputCap)
                : undefined;
            if (recovery) {
              // Repeat the call from the same context; its thinking is discarded with `buffered`.
              state.selfRecoveries += 1;
              lengthRecovered = true;
              outputBudget = recovery.maxTokens ?? outputBudget;
              thinkingOverride = recovery.thinkingLevel ?? thinkingOverride;
              buffered = [];
              restart = true;
              break;
            }
            for (const pending of buffered) output.push(pending);
            buffered = [];
            output.push(event);
            output.end(event.message);
            return;
          }
          lastPartial = {
            ...event.partial,
            content: event.partial.content.map((part) => ({ ...part })),
          };
          if (eventHasVisibleOutput(event)) {
            sawVisibleOutput = true;
            for (const pending of buffered) output.push(pending);
            buffered = [];
            output.push(event);
          } else if (sawVisibleOutput) {
            output.push(event);
          } else {
            buffered.push(event);
          }
        }
      } catch (error) {
        for (const pending of buffered) output.push(pending);
        finishWithThrownError(target, error);
        return;
      }
      if (restart) continue;
      for (const pending of buffered) output.push(pending);
      finishWithThrownError(target, new Error("Model stream ended without a terminal event"));
      return;
    }
    const target = state.getActive();
    finishWithThrownError(target, new Error("Model request was aborted"));
  };
  void run().catch((error: unknown) => finishWithThrownError(state.getActive(), error));
  return output;
}
