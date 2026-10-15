import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolResultContent,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  EXECUTION_HARNESS_VERSIONS,
  NativeLoginDescriptorSchema,
  nativeLoginEndpoint,
} from "@rakazo/contracts";
import { isToolPauseResult } from "./approval-effect.js";
import { buildClaudeProcess, runClaudeProtocol } from "./primary-harness-claude.js";
import { buildCodexProcess, runCodexProtocol } from "./primary-harness-codex.js";
import type { PrimaryHarnessHelperState } from "./primary-harness-helper.js";
import { createPrimaryHarnessHelper } from "./primary-harness-helper.js";
import { buildKimiProcess, runKimiProtocol } from "./primary-harness-kimi.js";
import { prepareNativeMedia, validateNativeToolContent } from "./primary-harness-media.js";
import type { NativeProtocolContext } from "./primary-harness-protocol.js";
import {
  NativeEventQueue,
  NativeHarnessPaused,
  NativeJsonlChannel,
  nativeObject,
} from "./primary-harness-protocol.js";

export type PrimaryHarness = "claude" | "codex" | "kimi";

export const PRIMARY_HARNESS_CAPABILITIES = {
  streaming: true,
  compaction: false,
  tools: true,
  scripted: false,
  cancellation: true,
  nativeResume: true,
  canonicalHistoryContinuation: true,
  toolBridge: true,
  approvals: true,
  nativeComputer: false,
  nativeSubagents: false,
  delegatedAgents: true,
} as const;

export interface PrimaryHarnessRuntimeOptions {
  harness: PrimaryHarness;
  runtimeVersion: string;
  protocol: "anthropic" | "openai-responses" | "openai-chat-completions";
  sandbox: SandboxProvider;
  computer: ComputerRef;
  context: AdapterContext;
  accountId: string;
  profileId: string;
  profileRevision: number;
  sessionEpoch: string;
  parentSessionEpoch?: string;
  nativeCheckpoint?: string;
  nativeLogin?: boolean;
  /** Internal recursion guard. Native vendor delegation is never enabled. */
  helperDepth?: number;
  /** Durable checkpoint barrier; called before a native tool can have an effect. */
  onCheckpoint?: (blob: string) => Promise<void>;
}

const PROTOCOLS = {
  claude: "anthropic",
  codex: "openai-responses",
  kimi: "openai-chat-completions",
} as const;
const MAX_TURN_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_RESULT_BYTES = 512 * 1024;

/** Vendor selection never touches Pi or resolves a second account/model. */
export function createPrimaryHarnessRuntime(options: PrimaryHarnessRuntimeOptions): AgentRuntime {
  return new PrimaryHarnessRuntime(options);
}

class PrimaryHarnessRuntime implements AgentRuntime {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly options: PrimaryHarnessRuntimeOptions) {
    if (options.helperDepth !== undefined && options.helperDepth !== 0 && options.helperDepth !== 1)
      throw new Error("Invalid native helper depth.");
    if (options.protocol !== PROTOCOLS[options.harness]) {
      throw new Error("The selected harness does not support this connection protocol.");
    }
    if (options.runtimeVersion !== EXECUTION_HARNESS_VERSIONS[options.harness]) {
      throw new Error("The selected native harness version is not supported.");
    }
    if (
      !options.accountId ||
      !options.profileId ||
      options.profileRevision < 1 ||
      !options.sessionEpoch
    ) {
      throw new Error("Native harness requires an explicit account and profile revision.");
    }
    if (!options.sandbox.startProcess) {
      throw new Error("This computer provider does not support isolated native harness processes.");
    }
  }

  describe() {
    return {
      id: this.options.harness,
      contractVersion: "1",
      adapterVersion: this.options.runtimeVersion,
      capabilities: { ...PRIMARY_HARNESS_CAPABILITIES, delegatedAgents: !this.options.nativeLogin },
    };
  }

  async abort(runId: string): Promise<void> {
    this.running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    validateNativeRequest(request, this.options);
    await prepareNativeMedia(request, this.options.harness);
    if (this.running.has(request.runId)) throw new Error("Native harness run is already active.");
    const controller = new AbortController();
    this.running.set(request.runId, controller);
    const signal = AbortSignal.any([
      controller.signal,
      this.options.context.signal,
      ...(context?.signal ? [context.signal] : []),
      AbortSignal.timeout(MAX_TURN_MS),
    ]);
    const queue = new NativeEventQueue<AgentRuntimeEvent>();
    const task = this.execute(request, signal, queue);
    // An early iterator return still awaits all cleanup in finally.
    void task.catch(() => undefined);
    try {
      yield* queue;
    } finally {
      controller.abort();
      await task;
      this.running.delete(request.runId);
    }
  }

  private async execute(
    request: AgentRunRequest,
    signal: AbortSignal,
    queue: NativeEventQueue<AgentRuntimeEvent>,
  ): Promise<void> {
    const { harness } = this.options;
    let nativeSessionId: string | undefined;
    let sessionEstablished = false;
    let usageState: Record<string, unknown> | undefined;
    let helpers: Record<string, PrimaryHarnessHelperState> = {};
    let checkpointPending = Promise.resolve();
    const persistCheckpoint = () => {
      checkpointPending = checkpointPending.then(async () => {
        if (!nativeSessionId)
          throw new Error("Native session must be established before helper effects.");
        const blob = this.checkpoint(request, nativeSessionId, usageState, helpers);
        await this.options.onCheckpoint?.(blob);
      });
      return checkpointPending;
    };
    let channel: NativeJsonlChannel | undefined;
    let interrupt: (() => Promise<void>) | undefined;
    let cleanup: Promise<void> | undefined;
    let usagePending = Promise.resolve();
    let emittedBytes = 0;
    const stop = () => {
      if (!channel || cleanup) return;
      const activeChannel = channel;
      // Never let an unresponsive native interrupt delay process-tree termination.
      const cancellation = interrupt?.().catch(() => undefined);
      cleanup = (async () => {
        if (cancellation) {
          await Promise.race([
            cancellation,
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
          ]);
        }
        await activeChannel.close();
      })();
      void cleanup.catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      nativeSessionId = this.readCheckpoint(request);
      if (this.options.nativeCheckpoint) {
        const checkpoint = nativeObject(JSON.parse(this.options.nativeCheckpoint));
        if (checkpoint.usageState !== undefined) usageState = nativeObject(checkpoint.usageState);
        if (checkpoint.helperRunId === request.runId && checkpoint.helpers !== undefined) {
          const saved = nativeObject(checkpoint.helpers);
          if (
            Object.keys(saved).length > 4 ||
            Object.keys(saved).some((key) => !/^native-helper-[a-f0-9]{64}$/.test(key))
          )
            throw new Error("Invalid native helper checkpoint map.");
          helpers = saved as Record<string, PrimaryHarnessHelperState>;
        }
      }
      const build = {
        claude: buildClaudeProcess,
        codex: buildCodexProcess,
        kimi: buildKimiProcess,
      }[harness];
      const process = await this.options.sandbox.startProcess!(
        this.options.computer,
        {
          ...build(request),
          isolation: "primary-harness",
          timeoutMs: MAX_TURN_MS,
          ...(request.model.nativeLogin
            ? {
                credentialScope: {
                  harness: request.model.nativeLogin.harness,
                  connectionId: request.model.nativeLogin.connectionId,
                  epoch: request.model.nativeLogin.epoch,
                },
              }
            : {}),
          sessionScope: {
            threadId: request.threadId,
            profileId: this.options.profileId,
            profileRevision: this.options.profileRevision,
            accountId: this.options.accountId,
            epoch: this.options.sessionEpoch,
            parentEpoch: this.options.parentSessionEpoch ?? this.options.sessionEpoch,
          },
        },
        { ...this.options.context, runId: request.runId, botId: request.botId, signal },
      );
      channel = new NativeJsonlChannel(process, signal, harness === "kimi");
      if (signal.aborted) {
        stop();
        signal.throwIfAborted();
      }
      const emit = (event: AgentRuntimeEvent) => {
        signal.throwIfAborted();
        emittedBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
        if (emittedBytes > MAX_OUTPUT_BYTES)
          throw new Error("Native harness output limit reached.");
        if (event.type === "usage" && request.onUsage && !event.accounted) {
          usagePending = usagePending.then(async () => {
            await request.onUsage!(event);
            queue.push({ ...event, accounted: true });
          });
          void usagePending.catch(() => undefined);
        } else {
          queue.push(event);
        }
      };
      const helper = createPrimaryHarnessHelper({
        options: this.options,
        request,
        signal,
        emit,
        createRuntime: createPrimaryHarnessRuntime,
        depth: this.options.helperDepth ?? 0,
        getState: (key) => helpers[key],
        saveState: async (key, state) => {
          if (!helpers[key] && Object.keys(helpers).length >= 4)
            throw new Error("Native helper checkpoint limit reached.");
          helpers[key] = state;
          await persistCheckpoint();
        },
      });
      const tools = request.tools.filter(
        (tool) =>
          (!this.options.helperDepth && !request.model.nativeLogin) || tool.name !== "run_subagent",
      );
      const permittedTools = new Map(tools.map((tool) => [tool.name, tool]));
      if (permittedTools.size !== tools.length)
        throw new Error("Duplicate native bridge tool names.");
      const calls = new Map<
        string,
        {
          signature: string;
          result: Promise<{ text: string; isError: boolean; content?: AgentToolResultContent[] }>;
        }
      >();
      const callTool: NativeProtocolContext["callTool"] = async (name, args, callId) => {
        signal.throwIfAborted();
        if (!sessionEstablished)
          throw new Error("Native harness requested a tool before establishing its session.");
        const tool = permittedTools.get(name);
        if (!tool || !callId || callId.length > 256) {
          throw new Error(
            request.model.nativeLogin && name === "run_subagent"
              ? "Helpers are unavailable with native sign-in because this account requires exclusive credential access. Use an API-key profile for helper delegation."
              : "Native harness requested an unauthorized tool.",
          );
        }
        nativeObject(args);
        const signature = JSON.stringify([name, args]);
        const existing = calls.get(callId);
        if (existing) {
          if (existing.signature !== signature)
            throw new Error("Native tool call identity changed.");
          return existing.result;
        }
        if (calls.size >= MAX_TOOL_CALLS)
          throw new Error("Native harness tool-call limit reached.");
        const executionId = JSON.stringify(["native-tool", harness, request.runId, callId]);
        const result = (async () => {
          emit({ type: "tool", name, args, executionId });
          const startedAt = Date.now();
          let value: unknown;
          let failure: unknown;
          let paused = false;
          try {
            if (name === "ask_user") {
              const options = Array.isArray(args.options) ? args.options : [];
              if (
                typeof args.question !== "string" ||
                !args.question.trim() ||
                options.length < 2 ||
                options.length > 4 ||
                options.some(
                  (label) => typeof label !== "string" || !label.trim() || label.length > 80,
                ) ||
                new Set(options).size !== options.length
              ) {
                throw new Error("ask_user requires a question and two to four unique options.");
              }
              emit({
                type: "ask",
                text: args.question,
                actions: options.map((label, index) => ({
                  id: `choice-${index + 1}`,
                  label: String(label),
                })),
              });
              paused = true;
              throw new NativeHarnessPaused();
            }
            if (name === "request_takeover") {
              emit({ type: "takeover", reason: String(args.reason ?? "Your input is needed.") });
              paused = true;
              throw new NativeHarnessPaused();
            }
            if (name === "run_subagent") {
              value = await helper.run(args, executionId);
            } else {
              if (!request.executeTool)
                throw new Error("Native harness tool bridge is unavailable.");
              value = await request.executeTool(name, args, executionId, tool.route);
            }
            if (isToolPauseResult(value)) {
              paused = true;
              // Executor checks its approval flag after consuming the next runtime event.
              emit({ type: "progress", text: "Waiting for your input.", activity: true });
              throw new NativeHarnessPaused();
            }
            signal.throwIfAborted();
            return {
              ...(await serializeNativeToolResult(value, request, harness)),
              isError: false,
            };
          } catch (error) {
            if (error instanceof NativeHarnessPaused) paused = true;
            failure = error;
            throw error;
          } finally {
            await request.onToolCompleted?.({
              name,
              executionId,
              durationMs: Date.now() - startedAt,
              result: value,
              error: failure,
              paused,
            });
          }
        })();
        calls.set(callId, { signature, result });
        return result;
      };
      const driver = { claude: runClaudeProtocol, codex: runCodexProtocol, kimi: runKimiProtocol }[
        harness
      ];
      await driver(channel, {
        request,
        tools,
        prompt: nativePrompt(request),
        nativeSessionId,
        usageState,
        onSession: async (id) => {
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
            throw new Error("Invalid native harness session identifier.");
          }
          if (nativeSessionId && nativeSessionId !== id) {
            throw new Error("Native harness session changed unexpectedly.");
          }
          nativeSessionId = id;
          const blob = this.checkpoint(request, id, usageState, helpers);
          await persistCheckpoint();
          sessionEstablished = true;
          emit({ type: "checkpoint", blob });
        },
        onUsageState: (state) => {
          if (JSON.stringify(state).length > 8 * 1024)
            throw new Error("Native usage checkpoint is too large.");
          usageState = state;
          if (nativeSessionId)
            emit({
              type: "checkpoint",
              blob: this.checkpoint(request, nativeSessionId, state, helpers),
            });
        },
        signal,
        emit,
        callTool,
        setInterrupt: (callback) => {
          interrupt = callback;
        },
      });
      await usagePending;
      signal.throwIfAborted();
      if (!nativeSessionId)
        throw new Error("Native harness did not establish a resumable session.");
      stop();
      await cleanup;
      const blob = this.checkpoint(request, nativeSessionId, usageState, helpers);
      await persistCheckpoint();
      emit({ type: "checkpoint", blob });
      emit({ type: "done" });
      queue.end();
    } catch (error) {
      await usagePending.catch(() => undefined);
      if (error instanceof NativeHarnessPaused) {
        if (nativeSessionId) {
          const blob = this.checkpoint(request, nativeSessionId, usageState, helpers);
          try {
            await persistCheckpoint();
            queue.push({ type: "checkpoint", blob });
          } catch (persistenceError) {
            queue.end(persistenceError);
            return;
          }
        }
        queue.end();
      } else {
        queue.end(error);
      }
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      await cleanup;
    }
  }

  private checkpoint(
    request: AgentRunRequest,
    nativeSessionId: string,
    usageState?: Record<string, unknown>,
    helpers?: Record<string, PrimaryHarnessHelperState>,
  ): string {
    const blob = JSON.stringify({
      version: 1,
      harness: this.options.harness,
      nativeSessionId,
      usageState,
      epoch: this.options.sessionEpoch,
      credentialEpoch: request.model.nativeLogin?.epoch,
      profileId: this.options.profileId,
      profileRevision: this.options.profileRevision,
      accountId: this.options.accountId,
      botId: request.botId,
      threadId: request.threadId,
      ...(helpers && Object.keys(helpers).length ? { helperRunId: request.runId, helpers } : {}),
    });
    if (Buffer.byteLength(blob, "utf8") > 16 * 1024)
      throw new Error("Native checkpoint exceeds the storage limit.");
    return blob;
  }

  private readCheckpoint(request: AgentRunRequest): string | undefined {
    if (!this.options.nativeCheckpoint) return undefined;
    let value: Record<string, unknown>;
    try {
      if (this.options.nativeCheckpoint.length > 16 * 1024) throw new Error();
      value = nativeObject(JSON.parse(this.options.nativeCheckpoint));
    } catch {
      throw new Error("Native harness checkpoint is invalid; start a new session explicitly.");
    }
    const expected = nativeObject(JSON.parse(this.checkpoint(request, "placeholder")));
    for (const key of Object.keys(expected)) {
      if (key !== "nativeSessionId" && value[key] !== expected[key]) {
        throw new Error("Native harness checkpoint does not match this account and conversation.");
      }
    }
    if (
      typeof value.nativeSessionId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value.nativeSessionId)
    ) {
      throw new Error("Native harness checkpoint has an invalid session identifier.");
    }
    return value.nativeSessionId;
  }
}

function validateNativeRequest(
  request: AgentRunRequest,
  options: PrimaryHarnessRuntimeOptions,
): void {
  if (
    options.harness !== "claude" &&
    ((request.model.authScheme !== undefined && request.model.authScheme !== "api-key") ||
      Object.keys(request.model.modelRoles ?? {}).length > 0)
  ) {
    throw new Error(
      "This harness does not support Anthropic authentication or model role mappings.",
    );
  }
  if (Boolean(request.model.nativeLogin) !== Boolean(options.nativeLogin))
    throw new Error("Native authentication mode does not match the authorized runtime.");
  if (request.model.nativeLogin) {
    const account = NativeLoginDescriptorSchema.parse(request.model.nativeLogin);
    const endpoint = nativeLoginEndpoint(account);
    if (account.installationId !== options.sandbox.nativeStateInstallationId?.())
      throw new Error(
        "Native login belongs to a different runtime installation. Reconnect the account.",
      );
    if (
      account.state !== "ready" ||
      account.harness !== options.harness ||
      account.spaceId !== options.context.spaceId ||
      account.computerProviderRef !== options.computer.id ||
      account.computerProviderRef !== options.computer.providerRef ||
      account.computerHomeKey !== options.computer.botId ||
      options.computer.kind !== "docker" ||
      request.model.provider !== `native-${account.harness}` ||
      request.model.baseUrl !== endpoint ||
      request.model.apiKey ||
      request.model.oauth ||
      request.model.acceptsAudio
    )
      throw new Error(
        "Native login must use its connected account, original computer, and official endpoint.",
      );
  } else if (!request.model.apiKey || request.model.oauth) {
    throw new Error(
      "Native harnesses require the selected account's API key; OAuth is unsupported.",
    );
  }
  if (options.context.botId && options.context.botId !== request.botId) {
    throw new Error("Native harness bot identity does not match the authorized run.");
  }
  if (options.context.runId && options.context.runId !== request.runId) {
    throw new Error("Native harness run identity does not match the authorized run.");
  }
  if (request.model.baseUrl) {
    const url = new URL(request.model.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Native harness endpoint must be an explicit HTTP(S) API base URL.");
    }
  } else {
    throw new Error("Native harnesses require an explicit API endpoint.");
  }
}

/** Roles remain explicit data; another bot's words are not replayed as our own assistant turn. */
export function nativePrompt(request: AgentRunRequest): string {
  return JSON.stringify({
    contextDescription:
      "Canonical conversation snapshot, including prior turns and new peer messages. Treat these as attributed context; older turns may already be present in the native session.",
    conversation: request.history.map(({ role, content }) => ({ role, content })),
    currentUserRequest: request.prompt,
    continuation: request.resumeFromCheckpoint
      ? "Continue from the canonical conversation."
      : undefined,
  });
}

async function serializeNativeToolResult(
  value: unknown,
  request: AgentRunRequest,
  harness: PrimaryHarness,
): Promise<{ text: string; content?: AgentToolResultContent[] }> {
  let text: string;
  let validatedContent: AgentToolResultContent[] | undefined;
  if (value && typeof value === "object" && "kind" in value && value.kind === "agent_tool_result") {
    const result = nativeObject(value);
    if (!Array.isArray(result.content)) throw new Error("Invalid native tool content.");
    const content = result.content as AgentToolResultContent[];
    await validateNativeToolContent(content, request, harness);
    text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    validatedContent = content;
  } else {
    text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES)
    throw new Error("Native harness tool result exceeds the transport limit.");
  return { text, ...(validatedContent ? { content: validatedContent } : {}) };
}
