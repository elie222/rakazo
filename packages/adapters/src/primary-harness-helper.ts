import { createHash } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isToolPauseResult } from "./approval-effect.js";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { NativeHarnessPaused, nativeObject } from "./primary-harness-protocol.js";
import type { PrimaryHarnessRuntimeOptions } from "./primary-harness-runtime.js";

const MAX_HELPERS = 4;
const MAX_CHECKPOINT_BYTES = 2 * 1024;
const MAX_RESULT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const CHILD_CONTROL_TOOLS = new Set(["ask_user", "request_takeover"]);

/** Small enough that four children fit inside the parent's 16 KiB opaque checkpoint. */
export interface PrimaryHarnessHelperState {
  version: 1;
  signature: string;
  checkpoint?: string;
  result?: string;
  waitingForInput?: boolean;
}

interface HelperOptions {
  options: PrimaryHarnessRuntimeOptions;
  request: AgentRunRequest;
  signal: AbortSignal;
  emit(event: AgentRuntimeEvent): void;
  createRuntime(options: PrimaryHarnessRuntimeOptions): AgentRuntime;
  depth: number;
  getState(stateKey: string): PrimaryHarnessHelperState | undefined;
  /** Must durably save the whole parent's checkpoint, serializing concurrent children. */
  saveState(stateKey: string, state: PrimaryHarnessHelperState): Promise<void>;
}

/**
 * A native helper is a separate isolated process on the exact pinned parent profile.
 * Its model can only invoke the parent's authorized tool catalog and effect bridge.
 */
export function createPrimaryHarnessHelper(config: HelperOptions): {
  run(args: Record<string, unknown>, executionId: string): Promise<string>;
} {
  const calls = new Map<string, { signature: string; result: Promise<string> }>();
  const signatures = new Set<string>();
  return {
    run(args, executionId) {
      try {
        config.signal.throwIfAborted();
        if (config.depth !== 0) throw new Error("Native helpers cannot delegate further.");
        if (!executionId || executionId.length > 2048)
          throw new Error("Invalid native helper execution identity.");
        nativeObject(args);
        if (args.model_provider !== undefined || args.model_id !== undefined) {
          throw new Error(
            "Native helpers use the parent's exact model; model overrides are unsupported.",
          );
        }
        const name = boundedInput(args.name, "name", 80, "helper");
        const task = boundedInput(args.task, "task", 64 * 1024);
        const instructions = boundedInput(args.instructions, "instructions", 16 * 1024, "");
        const signature = digest([name, task, instructions]);
        const existing = calls.get(executionId);
        if (existing) {
          if (existing.signature !== signature)
            throw new Error("Native helper execution identity changed.");
          return existing.result;
        }
        if (calls.size >= MAX_HELPERS)
          throw new Error("Native helper limit reached for this turn.");
        // Native request IDs can reset on resume, and completed calls may not be replayed.
        // A semantic helper request is single-use per run: there is no safe way to infer
        // which identical occurrence a newly resumed native tool call intended.
        if (signatures.has(signature)) {
          throw new Error(
            "An identical native helper request cannot run twice in one turn; reuse its result or give it a distinct task.",
          );
        }
        signatures.add(signature);
        const stateKey = `native-helper-${digest([config.request.runId, signature])}`;
        const identity = digest([
          "native-helper",
          config.options.harness,
          config.options.accountId,
          config.options.profileId,
          config.options.profileRevision,
          config.options.sessionEpoch,
          config.options.context.spaceId,
          config.options.context.userId,
          config.request.botId,
          config.request.threadId,
          stateKey,
        ]);
        const result = runHelper(config, {
          name,
          task,
          instructions,
          stateKey,
          identity,
          signature: digest([identity, signature]),
        });
        calls.set(executionId, { signature, result });
        return result;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

async function runHelper(
  config: HelperOptions,
  input: {
    name: string;
    task: string;
    instructions: string;
    stateKey: string;
    identity: string;
    signature: string;
  },
): Promise<string> {
  const { options, request, signal, emit } = config;
  const { name, task, stateKey: agentId, identity, signature } = input;
  let state = config.getState(agentId) ?? { version: 1, signature };
  validateState(state, signature);
  if (state.result !== undefined) {
    emit({ type: "subagent", agentId, name, task, status: "completed", result: state.result });
    return state.result;
  }
  const status = (value: "running" | "completed" | "failed", detail: string) => {
    emit({
      type: "subagent",
      agentId,
      name,
      task,
      status: value,
      ...(value === "running" ? { progress: detail } : { result: detail }),
    });
  };
  let savePending = Promise.resolve();
  const save = (update: (current: PrimaryHarnessHelperState) => PrimaryHarnessHelperState) => {
    // A child's pause checkpoint can arrive while its input event is being saved.
    // Serialize transformations too, so neither write captures an obsolete state.
    savePending = savePending.then(async () => {
      const next = update(state);
      validateState(next, signature);
      await config.saveState(agentId, next);
      state = next;
    });
    return savePending;
  };
  let child: AgentRuntime | undefined;
  // Keep the authorized parent run scope; the private epoch and callback IDs isolate children.
  const runId = request.runId;
  const effectId = (id: string) => {
    if (!id || id.length > 2048) throw new Error("Invalid native helper tool identity.");
    return `native-helper-tool-${digest([identity, id])}`;
  };
  const usage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => ({
    ...event,
    operationKind: "subagent" as const,
    agentId,
    // A native runtime's IDs are only locally unique, even when two children share a model.
    callId: `native-helper-usage-${digest([identity, event.callId ?? "unidentified"])}`,
  });
  let approvalPaused = false;
  const abortChild = () => {
    void child?.abort(runId).catch(() => undefined);
  };
  signal.addEventListener("abort", abortChild, { once: true });
  try {
    signal.throwIfAborted();
    await save((current) => current);
    signal.throwIfAborted();
    status("running", "Starting helper.");
    const tools = request.tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.name));
    const permitted = new Map(tools.map((tool) => [tool.name, tool]));
    if (permitted.size !== tools.length) throw new Error("Duplicate native helper tools.");
    const effects = new Map<string, { signature: string; result: Promise<unknown> }>();
    const childRequest: AgentRunRequest = {
      botId: request.botId,
      threadId: request.threadId,
      runId,
      prompt: task,
      instructions: [
        request.instructions,
        `You are a short-lived helper named ${JSON.stringify(name)} inside the parent bot's turn.`,
        "Complete only the delegated task and return a concise result. Do not delegate further. Request user input only when needed through the authorized tool bridge.",
        input.instructions,
        state.waitingForInput
          ? `Canonical parent continuation after your input request:\n${boundedInput(request.prompt, "continuation", 128 * 1024)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      // The helper uses the same authorized profile. Preserve media provenance rather than
      // silently dropping the pixels/audio the delegated task can refer to.
      history: request.history.filter((message) => message.images?.length || message.audio?.length),
      sourceMessageId: request.sourceMessageId,
      currentTurnImages: request.currentTurnImages,
      currentTurnAudio: request.currentTurnAudio,
      tools,
      model: { ...request.model },
      usageOperationKind: "subagent",
      contextStrategy: request.contextStrategy,
      // Construct explicitly: no fallback/model resolver, steering, script, or parent checkpoint. Media retains its original scope and provenance.
      executeTool: async (toolName, args, id) => {
        signal.throwIfAborted();
        const tool = permitted.get(toolName);
        if (!tool || CHILD_CONTROL_TOOLS.has(toolName) || !request.executeTool)
          throw new Error("Native helper requested an unauthorized tool.");
        nativeObject(args);
        const key = effectId(id);
        const callSignature = JSON.stringify([toolName, args]);
        const existing = effects.get(key);
        if (existing) {
          if (existing.signature !== callSignature)
            throw new Error("Native helper tool identity changed.");
          return existing.result;
        }
        const result = Promise.resolve().then(async () => {
          signal.throwIfAborted();
          // Always select the server-provided route, never a child-supplied route.
          const value = await request.executeTool!(toolName, args, key, tool.route);
          if (isToolPauseResult(value)) approvalPaused = true;
          return value;
        });
        effects.set(key, { signature: callSignature, result });
        return result;
      },
      onToolCompleted: request.onToolCompleted
        ? (completion) =>
            request.onToolCompleted!({
              ...completion,
              executionId: effectId(completion.executionId),
            })
        : undefined,
      onUsage: request.onUsage ? (event) => request.onUsage!(usage(event)) : undefined,
    };
    child = config.createRuntime({
      ...options,
      context: { ...options.context, runId, signal },
      sessionEpoch: `helper-${identity}`,
      parentSessionEpoch: options.parentSessionEpoch ?? options.sessionEpoch,
      nativeCheckpoint: state.checkpoint,
      onCheckpoint: (checkpoint) => save((current) => ({ ...current, checkpoint })),
      helperDepth: 1,
    });
    signal.throwIfAborted();
    let output = "";
    let outputBytes = 0;
    let complete = false;
    let lastProgress = 0;
    for await (const event of child.run(childRequest, { signal })) {
      signal.throwIfAborted();
      if (event.type === "usage") {
        const tagged = usage(event);
        if (!event.accounted && request.onUsage) {
          await request.onUsage(tagged);
          emit({ ...tagged, accounted: true });
        } else emit(tagged);
      } else if (event.type === "text") {
        outputBytes += Buffer.byteLength(event.text, "utf8");
        if (outputBytes > MAX_OUTPUT_BYTES) throw new Error("Native helper output limit reached.");
        output += event.text;
        if (Date.now() - lastProgress >= 80) {
          lastProgress = Date.now();
          status("running", output.slice(-800));
        }
      } else if (event.type === "tool") {
        if (!permitted.has(event.name))
          throw new Error("Native helper requested an unauthorized tool.");
        emit({ ...event, executionId: effectId(event.executionId) });
        status("running", `Using ${event.name}.`);
      } else if (event.type === "progress") {
        status("running", event.text.slice(0, 800));
      } else if (event.type === "ask" || event.type === "takeover") {
        const controlTool = event.type === "ask" ? "ask_user" : "request_takeover";
        if (!permitted.has(controlTool) || !state.checkpoint)
          throw new Error(
            "Native helper input requires an authorized tool and durable checkpoint.",
          );
        await save((current) => ({ ...current, waitingForInput: true }));
        emit(event);
        approvalPaused = true;
        throw new NativeHarnessPaused();
      } else if (event.type === "subagent") {
        throw new Error("Native helpers cannot delegate further.");
      } else if (event.type === "done") {
        complete = true;
        if (!output && event.text) output = event.text;
      }
      // Child checkpoints are persisted by onCheckpoint; never replace the parent's session.
    }
    if (approvalPaused) throw new NativeHarnessPaused();
    if (!complete) throw new Error("Native helper ended without explicit completion.");
    const result = boundedResult(output.trim() || "The helper finished without a text response.");
    await save((current) => ({ ...current, result, waitingForInput: false }));
    signal.throwIfAborted();
    status("completed", result);
    return result;
  } catch (error) {
    if (approvalPaused || error instanceof NativeHarnessPaused) {
      status("running", "Waiting for your input.");
      throw new NativeHarnessPaused();
    }
    // Native diagnostics may contain account information. Do not put them into helper UI.
    status("failed", signal.aborted ? "Helper cancelled." : "Helper failed.");
    throw error;
  } finally {
    signal.removeEventListener("abort", abortChild);
    await child?.abort(runId);
  }
}

function validateState(state: PrimaryHarnessHelperState, signature: string): void {
  if (
    state.version !== 1 ||
    state.signature !== signature ||
    (state.waitingForInput !== undefined && typeof state.waitingForInput !== "boolean") ||
    (state.checkpoint !== undefined &&
      (typeof state.checkpoint !== "string" ||
        Buffer.byteLength(state.checkpoint, "utf8") > MAX_CHECKPOINT_BYTES)) ||
    (state.result !== undefined &&
      (typeof state.result !== "string" ||
        Buffer.byteLength(state.result, "utf8") > MAX_RESULT_BYTES))
  ) {
    throw new Error("Native helper checkpoint does not match this execution or exceeds its limit.");
  }
}

function boundedInput(value: unknown, label: string, maxBytes: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string" ||
    (!value.trim() && fallback === undefined) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`Invalid native helper ${label}.`);
  }
  return value.trim();
}

function boundedResult(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text;
  const suffix = "\n[Result truncated.]";
  const limit = MAX_RESULT_BYTES - Buffer.byteLength(suffix, "utf8");
  let result = "";
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > limit) break;
    result += character;
  }
  return result + suffix;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
