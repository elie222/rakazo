import type { Agent, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolCompletion,
  AgentToolExecutionResult,
  ConnectorTool,
  ModelCallObserver,
} from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { isToolPauseResult } from "./approval-effect.js";
import {
  connectionIdArgument,
  credentialArgument,
  loginFieldLabelsArgument,
} from "./bot-secrets.js";
import { shortenToolResultText } from "./context-selection.js";
import type { PiAgentRuntimeOptions } from "./pi-runtime.js";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";
import { clipToolResultContent, clipToolResultText } from "./pi-runtime-limits.js";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import { executeSubagent } from "./pi-runtime-subagent.js";
import { parametersFor, prepareFleetArguments } from "./pi-runtime-tool-parameters.js";
import { recordPiTelemetryContent, withPiTelemetrySpan } from "./pi-telemetry.js";
import { VERBATIM_TOOL_RESULTS } from "./runtime-context.js";
import { SCHEDULE_TOOL_NAMES } from "./schedule-tools.js";
import type { FinishedShellCommand } from "./shell-command-stream.js";
import { textContentArg } from "./tool-text.js";

export interface ToolCallBudget {
  count: number;
  exceeded: boolean;
  limit: number;
  inFlight: number;
}
// Optional fuse is process-local. continueRun on another worker starts at zero.
const toolCallBudgetsByRun = new Map<string, ToolCallBudget>();

// Pi forwards these names to OpenAI Responses, whose function-name contract is
// ^[a-zA-Z0-9_-]+$ with a maximum length of 64 characters.
const AGENT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_AGENT_TOOL_NAME_LENGTH = 64;
const FALLBACK_AGENT_TOOL_NAME = "connector_tool";

/** Optional self-host fuse. Unset, empty, or 0 means unlimited (default). */
export function maxToolCallsPerTurn(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_TOOL_CALLS_PER_TURN?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export function toAgentTools(toolDefs: readonly ConnectorTool[], host: ToolHost): AgentTool[] {
  return namedAgentTools(toolDefs).map(({ tool, name }) => toAgentTool(tool, host, name));
}

/** Shared canonical mapping for checkpoint validation and runtime exposure. */
export function namedAgentTools(toolDefs: readonly ConnectorTool[]) {
  // Registration order is incidental. Canonicalize before allocating collision suffixes
  // so both provider-visible names and JSON schema serialization stay stable.
  const canonicalJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonicalJson(item)]),
      );
    }
    return value;
  };
  const ordered = toolDefs
    .map((tool) => ({
      tool: {
        ...tool,
        inputSchema: canonicalJson(tool.inputSchema) as Record<string, unknown>,
      },
      key: JSON.stringify(canonicalJson(tool)),
    }))
    .sort((a, b) =>
      a.tool.name < b.tool.name
        ? -1
        : a.tool.name > b.tool.name
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    )
    .map(({ tool }) => tool);
  const names = normalizeAgentToolNames(ordered);
  return ordered.map((tool, index) => ({ tool, name: names[index]! }));
}

/**
 * Normalize connector names only at the boundary where they are exposed to Pi.
 * Connector execution continues to use the original name captured by toAgentTool.
 */
export function normalizeAgentToolName(name: string): string {
  if (isProviderSafeAgentToolName(name)) return name;
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || FALLBACK_AGENT_TOOL_NAME).slice(0, MAX_AGENT_TOOL_NAME_LENGTH);
}

const ACTIVITY_DETAIL_LIMIT = 90;

/** One human-readable line describing a tool call, shown live in the thread. */
export function describeToolActivity(toolName: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const detail = (value: unknown): string => {
    const text = sanitizeSensitiveText(String(value ?? ""))
      .replaceAll(/\s+/g, " ")
      .trim();
    return text.length > ACTIVITY_DETAIL_LIMIT ? `${text.slice(0, ACTIVITY_DETAIL_LIMIT)}…` : text;
  };
  if (toolName === "shell") return `Running: ${detail(record.command)}`;
  if (toolName === "user_computer_shell")
    return `Running on your computer: ${detail(record.command)}`;
  if (toolName === "read_file") return `Reading ${detail(record.path)}`;
  if (toolName === "write_file") return `Writing ${detail(record.path)}`;
  if (toolName === "list_files") return `Listing ${detail(record.path ?? ".")}`;
  if (toolName === "attach_file") return `Attaching ${detail(record.path)}`;
  if (toolName === "open_path") return `Opening ${detail(record.path)}`;
  if (toolName === "render_plot") return "Rendering a chart";
  if (toolName === "add_mcp_server") return `Connecting MCP server: ${detail(record.name)}`;
  if (toolName === "computer_observe") return "Looking at the screen";
  if (toolName === "browser_navigate")
    return `Opening page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "browser_snapshot") return "Reading the page";
  if (toolName === "browser_act") return "Using the page";
  if (toolName === "computer_act") return "Operating the computer";
  if (toolName === "run_subagent") return `Delegating to helper: ${detail(record.name)}`;
  if (toolName === "create_space") return `Creating space: ${detail(record.name)}`;
  if (toolName === "list_fleet") return "Checking your bots";
  if (toolName === "create_group") return `Creating group: ${detail(record.name)}`;
  if (toolName === "update_group")
    return `Updating group: ${detail(record.group_name ?? record.name)}`;
  if (toolName === "organize_bot") return "Organizing the sidebar";
  if (toolName === "set_child_instructions") return "Rewriting a bot's instructions";
  if (toolName === "set_child_bot_model") return "Setting a bot's model";
  if (toolName === "create_child_routine") return `Scheduling routine: ${detail(record.name)}`;
  if (toolName === "remember") return "Saving a note to memory";
  if (toolName === "save_shared_memory") return `Saving shared memory: ${detail(record.path)}`;
  if (toolName === "web_search") return `Searching the web: ${detail(record.query)}`;
  if (toolName === "web_fetch") return `Reading page: ${detail(redactActivityUrl(record.url))}`;
  if (toolName === "skill_read")
    return record.file
      ? `Reading ${detail(record.file)} from ${detail(record.name)}`
      : `Reading skill: ${detail(record.name)}`;
  if (toolName === "skill_create") return `Creating skill: ${detail(record.name ?? "skill")}`;
  if (toolName === "skill_update")
    return `Updating skill: ${detail(record.name ?? record.skillId)}`;
  if (toolName === "skill_delete")
    return `Deleting skill: ${detail(record.name ?? record.skillId)}`;
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2]}`;
  return `Using ${toolName}`;
}

/**
 * Existing valid names are reserved first so sanitizing a connector cannot
 * rename or shadow a builtin tool with the same valid name.
 */
export function normalizeAgentToolNames(tools: readonly ConnectorTool[]): string[] {
  const reservedValidNames = new Set(
    tools.filter((tool) => isProviderSafeAgentToolName(tool.name)).map((tool) => tool.name),
  );
  const usedNames = new Set<string>();

  return tools.map((tool) => {
    const base = normalizeAgentToolName(tool.name);
    const originalIsValid = isProviderSafeAgentToolName(tool.name);
    let candidate = base;

    if (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, stableToolNameHash(tool.name));
    }

    let suffix = 2;
    while (usedNames.has(candidate) || (!originalIsValid && reservedValidNames.has(candidate))) {
      candidate = withToolNameSuffix(base, `${stableToolNameHash(tool.name)}_${suffix}`);
      suffix += 1;
    }

    usedNames.add(candidate);
    return candidate;
  });
}

function isProviderSafeAgentToolName(name: string): boolean {
  return AGENT_TOOL_NAME_PATTERN.test(name) && name.length <= MAX_AGENT_TOOL_NAME_LENGTH;
}

function withToolNameSuffix(base: string, suffix: string): string {
  const suffixWithSeparator = `_${suffix}`;
  const prefixLength = Math.max(1, MAX_AGENT_TOOL_NAME_LENGTH - suffixWithSeparator.length);
  return `${base.slice(0, prefixLength)}${suffixWithSeparator}`;
}

function stableToolNameHash(name: string): string {
  let hash = 2166136261;
  for (const character of name) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Missing label/purpose must fail rather than filling Code/otp placeholders.
 * `credential` and `replace` must survive: the executor stores a submitted
 * value only when `credential` is present. Top-level destination fields and a
 * JSON string credential are folded into `credential` so they are not dropped.
 */
export function prepareRequestSecretArguments(raw: Record<string, unknown>) {
  const label = raw.label == null ? "" : String(raw.label);
  const purpose = raw.purpose == null ? "" : String(raw.purpose);
  if (!label.trim() || !purpose.trim()) {
    throw new Error(
      `request_secret requires a non-empty label and purpose (received: ${
        Object.keys(raw).sort().join(", ") || "no arguments"
      })`,
    );
  }
  const credential = credentialArgument(raw);
  const connectionId = connectionIdArgument(raw.connectionId);
  return {
    label,
    purpose,
    ...(connectionId ? { connectionId } : {}),
    ...(credential !== undefined ? { credential } : {}),
    ...(raw.replace === true ? { replace: true } : {}),
    ...(raw.fields != null ? { fields: loginFieldLabelsArgument(raw.fields) } : {}),
  };
}

function toAgentTool(tool: ConnectorTool, host: ToolHost, exposedName: string): AgentTool {
  return {
    name: exposedName,
    label: tool.name,
    description: tool.description,
    // Pi runs a turn's tool calls concurrently by default, so a batch that
    // creates a routine and lists routines can read the list before the row
    // exists. Pi runs the whole batch in order when any call in it is
    // sequential. Remember also needs this to avoid competing revision writes.
    ...(SCHEDULE_TOOL_NAMES.has(tool.name) || tool.name === "remember"
      ? { executionMode: "sequential" as const }
      : {}),
    parameters: parametersFor(tool),
    prepareArguments: (args: unknown) => {
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (tool.name === "remember") {
        return {
          content: String(raw.content ?? ""),
          path: String(raw.path ?? "MEMORY.md"),
        };
      }
      if (tool.name === "request_takeover") {
        return { reason: String(raw.reason ?? "I need you on the screen.") };
      }
      if (tool.name === "ask_user") {
        const options = Array.isArray(raw.options) ? raw.options.map(String) : raw.options;
        return {
          question: String(raw.question ?? "What should I use?"),
          // Keep a missing/invalid options value as-is so schema minItems can reject it;
          // coercing to [] would look like a valid empty list upstream.
          options,
        };
      }
      if (tool.name === "request_secret") {
        return prepareRequestSecretArguments(raw);
      }
      if (tool.name === "write_file") {
        return {
          path: String(raw.path ?? "notes/result.txt"),
          content: textContentArg(raw.content, ""),
        };
      }
      if (tool.name === "computer_act") {
        return {
          actions: Array.isArray(raw.actions) ? raw.actions : [],
          observe: raw.observe === undefined ? true : Boolean(raw.observe),
          settle_ms: Number(raw.settle_ms ?? 350),
        };
      }
      if (tool.name === "list_files") return { path: String(raw.path ?? "") };
      if (tool.name === "read_file" || tool.name === "open_path") {
        return { path: String(raw.path ?? "") };
      }
      if (tool.name === "launch_app") {
        return {
          application: String(raw.application ?? ""),
          uri: raw.uri ? String(raw.uri) : "",
        };
      }
      if (tool.name === "shell" || tool.name === "user_computer_shell") {
        return {
          command: String(raw.command ?? ""),
          // The executor chooses the default: the bot's folder, or the user's home.
          ...(raw.cwd ? { cwd: String(raw.cwd) } : {}),
        };
      }
      if (tool.name === "run_subagent") {
        return {
          name: String(raw.name ?? "helper"),
          task: String(raw.task ?? ""),
          instructions: raw.instructions ? String(raw.instructions) : "",
          model_provider: raw.model_provider ? String(raw.model_provider) : "",
          model_id: raw.model_id ? String(raw.model_id) : "",
        };
      }
      if (tool.name === "spawn_bot") {
        return {
          name: String(raw.name ?? ""),
          description: raw.description ? String(raw.description) : "",
          instructions: raw.instructions ? String(raw.instructions) : "",
          prompt: raw.prompt ? String(raw.prompt) : "",
          computer_mode: raw.computer_mode ? String(raw.computer_mode) : "",
        };
      }
      if (tool.name === "update_bot" || FLEET_TOOL_NAMES.some((name) => name === tool.name)) {
        return prepareFleetArguments(tool.name, raw);
      }
      if (tool.name === "create_space") {
        return { name: String(raw.name ?? "") };
      }
      if (tool.name === "archive_bot" || tool.name === "delete_bot") {
        return {
          confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
          bot_id: raw.bot_id ? String(raw.bot_id) : raw.botId ? String(raw.botId) : "",
        };
      }
      return raw as never;
    },
    execute: async (toolCallId, params): Promise<AgentToolResult<unknown>> =>
      withPiTelemetrySpan(
        "pi.agent.tool",
        {
          "pi.agent.tool.name": tool.name,
        },
        async (span) => {
          host.signal.throwIfAborted();
          const args = (params ?? {}) as Record<string, unknown>;
          recordPiTelemetryContent(span, "pi.agent.tool.arguments", args);
          const rawCallId =
            toolCallId || `${host.request.runId}:${tool.name}:${host.toolCallSeq.value++}`;
          // Backend idempotency includes the agent namespace; Pi wire IDs remain untouched.
          const executionId = JSON.stringify(["pi-tool", host.agentNamespace ?? "main", rawCallId]);
          // A sequential tail cannot start after its preceding call pauses.
          // This makes the saved sequential tail safe to resolve on resume.
          if (host.pausePending)
            return { content: [], details: { skipped: true }, terminate: true };
          if (host.depth === 0) await host.captureCheckpoint?.(rawCallId, executionId);
          if (host.pausePending)
            return { content: [], details: { skipped: true }, terminate: true };
          if (!beginToolCall(host)) {
            return {
              content: [{ type: "text", text: "Skipped: tool-call limit reached." }],
              details: { skipped: true },
            };
          }
          host.queue.push({ type: "tool", name: tool.name, args, executionId });
          const startedAt = Date.now();
          let result: unknown;
          let failure: unknown;
          try {
            result = await (async () => {
              if (tool.name === "request_takeover") {
                host.pausePending = true;
                host.queue.push({
                  type: "takeover",
                  ...(host.request.onCheckpoint ? { executionId } : {}),
                  reason: String(args.reason ?? "I need you on the screen."),
                });
                return {
                  content: [{ type: "text", text: "Takeover requested." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === "ask_user") {
                const options = Array.isArray(args.options)
                  ? args.options.map((option) => String(option).trim())
                  : [];
                if (
                  options.length < 2 ||
                  options.length > 4 ||
                  options.some((option) => option.length === 0 || option.length > 80) ||
                  new Set(options).size !== options.length
                ) {
                  throw new Error("ask_user requires two to four unique, non-empty options");
                }
                host.pausePending = true;
                host.queue.push({
                  type: "ask",
                  ...(host.request.onCheckpoint ? { executionId } : {}),
                  text: String(args.question ?? "What should I use?"),
                  actions: options.map((label, index) => ({
                    id: `choice-${index + 1}`,
                    label,
                  })),
                });
                return {
                  content: [{ type: "text", text: "Waiting for the user's choice." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === "request_secret") {
                if (host.request.executeTool) {
                  const result = await host.request.executeTool(tool.name, args, executionId);
                  if (isAgentToolExecutionResult(result)) {
                    if (isToolPauseResult(result)) host.pausePending = true;
                    return result;
                  }
                  return {
                    content: [
                      {
                        type: "text",
                        text: serializeToolResult(
                          result,
                          host.request.contextStrategy,
                          tool.name,
                          args,
                        ),
                      },
                    ],
                    details: result,
                  };
                }
                host.pausePending = true;
                return {
                  content: [{ type: "text", text: "Protected input requested." }],
                  details: args,
                  terminate: true,
                };
              }
              if (tool.name === "run_subagent") {
                const result = await executeSubagent(host, executionId, args);
                return {
                  content: [{ type: "text", text: result }],
                  details: { result },
                };
              }
              if (host.request.executeTool) {
                const result = await host.request.executeTool(
                  tool.name,
                  args,
                  executionId,
                  tool.route,
                  {
                    onShellStillRunning: (completion) => {
                      host.pendingShells.push(completion);
                    },
                  },
                );
                if (isAgentToolExecutionResult(result)) {
                  if (isToolPauseResult(result)) host.pausePending = true;
                  return boundAgentToolResult(result);
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: serializeToolResult(
                        result,
                        host.request.contextStrategy,
                        tool.name,
                        args,
                      ),
                    },
                  ],
                  details: result,
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `${tool.name} is unavailable without an executor.`,
                  },
                ],
                details: { error: "no executor" },
              };
            })();
            if (VERBATIM_TOOL_RESULTS.has(tool.name)) return result as AgentToolResult<unknown>;
            return boundAgentToolResult(result as AgentToolResult<unknown>);
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            // Pi only terminates a parallel batch when every result terminates.
            // A single paused call must stop the turn before another model request.
            if (host.pausePending) host.abortTurn?.();
            const details = (
              result as AgentToolResult<{ error?: unknown; isError?: unknown }> | undefined
            )?.details;
            const failed =
              failure !== undefined || details?.error != null || details?.isError === true;
            span?.setAttributes({ "pi.agent.tool.success": !failed });
            recordPiTelemetryContent(span, "pi.agent.tool.result", result);
            if (failed) span?.setStatus({ status: "error" });
            endToolCall(host);
            const completion: AgentToolCompletion = {
              name: tool.name,
              executionId,
              durationMs: Math.max(0, Date.now() - startedAt),
              ...(result === undefined ? {} : { result }),
              ...(failure === undefined ? {} : { error: failure }),
              ...(host.pausePending ? { paused: true } : {}),
            };
            try {
              void Promise.resolve(host.request.onToolCompleted?.(completion)).catch(
                () => undefined,
              );
            } catch {
              // Audit hooks are best effort and must never change tool behavior.
            }
          }
        },
      ),
  };
}

function isAgentToolExecutionResult(result: unknown): result is AgentToolExecutionResult {
  if (
    !result ||
    typeof result !== "object" ||
    (result as { kind?: unknown }).kind !== "agent_tool_result" ||
    !("content" in result)
  ) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.every(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item as { type?: unknown }).type === "text" ||
          (item as { type?: unknown }).type === "image"),
    )
  );
}

export function serializeToolResult(
  result: unknown,
  strategy: AgentRunRequest["contextStrategy"],
  name: string,
  args: Record<string, unknown>,
) {
  try {
    const text = JSON.stringify(result);
    if (!text) return "ok";
    // skill-tools.ts already bounds skill content; the context budget selector may still shorten it.
    if (text.length <= 12_000 || VERBATIM_TOOL_RESULTS.has(name)) return text;
    return (strategy ?? DEFAULT_CONTEXT_STRATEGY) === "current"
      ? clipToolResultText(text)
      : shortenToolResultText(text, 12_000, { name, arguments: args });
  } catch {
    return "ok";
  }
}

function boundAgentToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T> {
  if (!result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: clipToolResultContent(result.content),
  };
}

/** Origin + path only for activity chips; drop userinfo, query, and fragment. */
function redactActivityUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Never echo unparsed input — it may still contain userinfo/secrets.
    return "[invalid URL]";
  }
}

export interface EventQueue {
  push(event: AgentRuntimeEvent): void;
  fail(error: Error): void;
  close(): void;
  iterate(): AsyncIterable<AgentRuntimeEvent>;
}

export interface ToolHost {
  context?: Partial<AdapterContext>;
  modelFetch?: typeof globalThis.fetch;
  onContextDecision?: PiAgentRuntimeOptions["onContextDecision"];
  modelCallObserver?: ModelCallObserver;
  queue: EventQueue;
  request: AgentRunRequest;
  activeModel: RuntimeModelTarget;
  models: Models;
  model: Model<Api>;
  apiKey: string | undefined;
  nestedAgents: Set<Agent>;
  subagentGate: { acquire(): Promise<void>; release(): void };
  toolCallBudget: ToolCallBudget;
  /** Shared fallback uniqueness when the model omits toolCallId (nested hosts reuse this). */
  toolCallSeq: { value: number };
  abortTurn(): void;
  signal: AbortSignal;
  depth: number;
  agentNamespace?: string;
  pausePending: boolean;
  captureCheckpoint?: (toolCallId: string, executionId: string) => Promise<void>;
  /** Shell commands that returned output and are still running. */
  pendingShells: Array<Promise<FinishedShellCommand>>;
}

export function toolCallBudgetExceededMessage(limit: number) {
  return `I stopped after reaching the limit of ${limit} tool calls in this turn. Send another message to continue.`;
}

export function toolCallBudgetFor(runId: string): ToolCallBudget {
  const existing = toolCallBudgetsByRun.get(runId);
  if (existing) {
    existing.inFlight = 0;
    existing.limit = maxToolCallsPerTurn();
    return existing;
  }
  const budget: ToolCallBudget = {
    count: 0,
    exceeded: false,
    limit: maxToolCallsPerTurn(),
    inFlight: 0,
  };
  if (budget.limit > 0) toolCallBudgetsByRun.set(runId, budget);
  return budget;
}

export function releaseToolCallBudget(runId: string, keepForResume: boolean) {
  if (!keepForResume) toolCallBudgetsByRun.delete(runId);
}

function maybeAbortToolCallBudget(host: ToolHost) {
  if (host.toolCallBudget.exceeded && host.toolCallBudget.inFlight === 0) {
    host.abortTurn();
  }
}

function beginToolCall(host: ToolHost): boolean {
  const budget = host.toolCallBudget;
  if (budget.limit <= 0) {
    budget.count += 1;
    return true;
  }
  if (budget.exceeded) {
    maybeAbortToolCallBudget(host);
    return false;
  }
  budget.count += 1;
  if (budget.count <= budget.limit) {
    budget.inFlight += 1;
    return true;
  }
  if (!budget.exceeded) {
    budget.exceeded = true;
    host.queue.push({
      type: "progress",
      text: `Stopped: more than ${budget.limit} tool calls in one turn.`,
    });
  }
  maybeAbortToolCallBudget(host);
  return false;
}

function endToolCall(host: ToolHost) {
  host.toolCallBudget.inFlight = Math.max(0, host.toolCallBudget.inFlight - 1);
  maybeAbortToolCallBudget(host);
}
