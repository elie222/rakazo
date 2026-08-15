import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type Model, type Models, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { builtinAgentTools, DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { PiRuntimeCredentialStore, toOAuthCredential } from "./pi-credentials.js";

const running = new Map<string, AbortController>();
const catalogModels = builtinModels();
const MAX_PARALLEL_SUBAGENTS = 4;
// Pi forwards these names to OpenAI Responses, whose function-name contract is
// ^[a-zA-Z0-9_-]+$ with a maximum length of 64 characters.
const AGENT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_AGENT_TOOL_NAME_LENGTH = 64;
const FALLBACK_AGENT_TOOL_NAME = "connector_tool";

export class PiAgentRuntime implements AgentRuntime {
  describe() {
    return {
      id: "pi",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    };
  }

  async abort(runId: string): Promise<void> {
    running.get(runId)?.abort();
  }

  async *run(request: AgentRunRequest, context: AdapterContext): AsyncIterable<AgentRuntimeEvent> {
    const controller = new AbortController();
    running.set(request.runId, controller);
    const signal = context.signal ?? controller.signal;
    const queue = createQueue();

    const work = (async () => {
      try {
        const provider =
          request.model.provider === "scripted" ? "openrouter" : request.model.provider;
        const modelId =
          request.model.id === "scripted"
            ? (process.env.PI_DEFAULT_MODEL ?? "deepseek/deepseek-v4-flash-0731")
            : request.model.id;
        const models = modelsForRequest(request, provider);
        const model = models.getModel(provider, modelId) ?? models.getModel("openrouter", modelId);
        if (!model) {
          queue.push({ type: "text", text: `Unknown model ${provider}/${modelId}` });
          queue.push({ type: "done" });
          return;
        }

        const apiKey = request.model.oauth
          ? undefined
          : (request.model.apiKey ?? process.env.OPENROUTER_API_KEY);
        const toolDefs = request.tools.length ? request.tools : builtinAgentTools;
        const nestedAgents = new Set<Agent>();
        const host: ToolHost = {
          queue,
          request,
          models,
          model,
          apiKey,
          nestedAgents,
          subagentGate: createGate(MAX_PARALLEL_SUBAGENTS),
          signal,
          depth: 0,
        };
        const tools = toAgentTools(toolDefs, host);
        const history = toHistory(request.history, request.prompt);

        const agent = new Agent({
          streamFn: (m, ctx, options) => models.streamSimple(m, ctx, options),
          getApiKey: async () => apiKey,
          transformContext: async (messages) => pruneComputerScreenshotContext(messages),
          initialState: {
            systemPrompt:
              request.instructions ||
              (toolDefs.some((tool) => tool.name === "computer_observe")
                ? "You are a Rakazo bot with a real computer. Use computer_observe and computer_act to operate its visible desktop, including browsers and installed applications. Use shell and the file tools for precise terminal and filesystem work. The user may interact with the same desktop while you run, so re-observe when the screen may have changed. Be concise."
                : "You are a Rakazo bot with a persistent sandbox filesystem and shell. Be concise."),
            model,
            thinkingLevel: "off",
            tools,
            messages: history,
          },
        });

        if (signal.aborted) {
          queue.push({ type: "done", text: "stopped" });
          return;
        }
        const onAbort = () => {
          agent.abort();
          for (const nested of nestedAgents) nested.abort();
        };
        signal.addEventListener("abort", onAbort);

        let streamed = "";
        agent.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            const delta = event.assistantMessageEvent.delta;
            if (delta) {
              streamed += delta;
              queue.push({ type: "text", text: delta });
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const text = assistantText(event.message);
            if (text && !streamed) {
              streamed = text;
              queue.push({ type: "text", text });
            }
            if ("usage" in event.message && event.message.usage) {
              queue.push({
                type: "usage",
                inputTokens: event.message.usage.input ?? 0,
                outputTokens: event.message.usage.output ?? 0,
                provider: model.provider,
                model: model.id,
              });
            }
          }
        });

        queue.push({ type: "progress", text: "working…" });
        await agent.prompt(request.prompt);
        await agent.waitForIdle();
        signal.removeEventListener("abort", onAbort);

        const error = agent.state.errorMessage;
        if (error) {
          queue.push({ type: "text", text: `I hit a problem: ${sanitizeError(error)}` });
          queue.push({ type: "done", text: sanitizeError(error) });
          return;
        }
        if (!streamed) {
          const fallback = assistantText(agent.state.messages.at(-1)) || "I finished the work.";
          queue.push({ type: "text", text: fallback });
          streamed = fallback;
        }
        queue.push({ type: "done", text: streamed });
      } catch (error) {
        const message = sanitizeError(error instanceof Error ? error.message : String(error));
        queue.push({ type: "text", text: `I hit a problem: ${message}` });
        queue.push({ type: "done", text: message });
      } finally {
        queue.close();
      }
    })();

    try {
      yield* queue.iterate();
      await work;
    } finally {
      running.delete(request.runId);
    }
  }
}

function modelsForRequest(request: AgentRunRequest, provider: string): Models {
  const oauth = request.model.oauth;
  if (!oauth) return catalogModels;

  const persist = oauth.persist;
  return builtinModels({
    credentials: new PiRuntimeCredentialStore(
      provider,
      toOAuthCredential(oauth.credential),
      persist ? (next) => persist(next) : undefined,
    ),
  });
}

function toAgentTools(toolDefs: readonly ConnectorTool[], host: ToolHost): AgentTool[] {
  const names = normalizeAgentToolNames(toolDefs);
  return toolDefs.map((tool, index) => toAgentTool(tool, host, names[index]!));
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

/**
 * Return one valid, unique model-facing name per connector tool.
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

function toHistory(history: AgentRunRequest["history"], prompt: string) {
  const last = history.at(-1);
  const prior = last?.role === "user" && last.content === prompt ? history.slice(0, -1) : history;
  return prior
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) =>
      m.role === "assistant"
        ? { role: "user" as const, content: `Assistant: ${m.content}`, timestamp: Date.now() }
        : { role: "user" as const, content: m.content, timestamp: Date.now() },
    );
}

function toAgentTool(tool: ConnectorTool, host: ToolHost, exposedName: string): AgentTool {
  return {
    name: exposedName,
    label: tool.name,
    description: tool.description,
    parameters: parametersFor(tool),
    prepareArguments: (args: unknown) => {
      const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      if (tool.name === "destination.write") {
        return {
          collection: String(raw.collection ?? "notes"),
          title: String(raw.title ?? "Rakazo result"),
          body: String(raw.body ?? ""),
        };
      }
      if (tool.name === "remember") {
        return { content: String(raw.content ?? ""), path: String(raw.path ?? "MEMORY.md") };
      }
      if (tool.name === "request_takeover") {
        return { reason: String(raw.reason ?? "I need you on the screen.") };
      }
      if (tool.name === "write_file") {
        return { path: String(raw.path ?? "notes/result.txt"), content: String(raw.content ?? "") };
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
      if (tool.name === "shell") {
        return {
          command: String(raw.command ?? ""),
          cwd: raw.cwd ? String(raw.cwd) : "/home/rakazo",
        };
      }
      if (tool.name === "run_subagent") {
        return {
          name: String(raw.name ?? "helper"),
          task: String(raw.task ?? ""),
          instructions: raw.instructions ? String(raw.instructions) : "",
        };
      }
      if (tool.name === "spawn_bot") {
        return {
          name: String(raw.name ?? ""),
          title: raw.title ? String(raw.title) : "",
          instructions: raw.instructions ? String(raw.instructions) : "",
          prompt: raw.prompt ? String(raw.prompt) : "",
        };
      }
      if (tool.name === "delete_bot") {
        return {
          confirm_name: String(raw.confirm_name ?? raw.confirmName ?? ""),
          bot_id: raw.bot_id ? String(raw.bot_id) : raw.botId ? String(raw.botId) : "",
        };
      }
      return raw as never;
    },
    execute: async (toolCallId, params) => {
      const args = (params ?? {}) as Record<string, unknown>;
      const executionId = toolCallId || `${host.request.runId}:${tool.name}`;
      host.queue.push({ type: "tool", name: tool.name, args, executionId });
      if (tool.name === "request_takeover") {
        host.queue.push({
          type: "takeover",
          reason: String(args.reason ?? "I need you on the screen."),
        });
        return {
          content: [{ type: "text", text: "Takeover requested." }],
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
        const result = await host.request.executeTool(tool.name, args, executionId);
        if (isAgentToolExecutionResult(result)) return result;
        return {
          content: [{ type: "text", text: summarizeToolResult(result) }],
          details: result,
        };
      }
      return {
        content: [{ type: "text", text: `${tool.name} is unavailable without an executor.` }],
        details: { error: "no executor" },
      };
    },
  };
}

async function executeSubagent(host: ToolHost, executionId: string, args: Record<string, unknown>) {
  if (host.depth > 0) return "Subagents cannot nest further.";
  await host.subagentGate.acquire();
  const agentId = executionId;
  const name =
    String(args.name ?? "helper")
      .trim()
      .slice(0, 80) || "helper";
  const task = String(args.task ?? "").trim();
  const extra = args.instructions ? String(args.instructions).trim() : "";
  host.queue.push({
    type: "subagent",
    agentId,
    name,
    task,
    status: "running",
    progress: "starting…",
  });

  const childDefs = (host.request.tools.length ? host.request.tools : builtinAgentTools).filter(
    (tool) => !DELEGATION_TOOL_NAMES.has(tool.name),
  );
  const nestedHost: ToolHost = { ...host, depth: 1 };
  const nested = new Agent({
    streamFn: (m, ctx, options) => host.models.streamSimple(m, ctx, options),
    getApiKey: async () => host.apiKey,
    transformContext: async (messages) => pruneComputerScreenshotContext(messages),
    initialState: {
      systemPrompt: [
        `You are a Rakazo subagent named "${name}".`,
        "You run inside the parent bot's turn — you are not a separate bot chat.",
        "Complete the task and return a concise result. Do not spawn bots or further subagents.",
        extra,
      ]
        .filter(Boolean)
        .join(" "),
      model: host.model,
      thinkingLevel: "off",
      tools: toAgentTools(childDefs, nestedHost),
      messages: [],
    },
  });
  host.nestedAgents.add(nested);

  let streamed = "";
  let lastPush = 0;
  nested.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const toolName = "toolName" in event && event.toolName ? String(event.toolName) : "a tool";
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "running",
        progress: `using ${toolName}…`,
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) {
        streamed += delta;
        const now = Date.now();
        if (now - lastPush >= 80) {
          lastPush = now;
          host.queue.push({
            type: "subagent",
            agentId,
            name,
            task,
            status: "running",
            progress: streamed.slice(-800),
          });
        }
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = assistantText(event.message);
      if (text && !streamed) streamed = text;
      if ("usage" in event.message && event.message.usage) {
        host.queue.push({
          type: "usage",
          inputTokens: event.message.usage.input ?? 0,
          outputTokens: event.message.usage.output ?? 0,
          provider: host.model.provider,
          model: host.model.id,
        });
      }
    }
  });

  try {
    if (host.signal.aborted) {
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: "stopped",
      });
      return "stopped";
    }
    const onAbort = () => nested.abort();
    host.signal.addEventListener("abort", onAbort);
    await nested.prompt(task || "Complete the delegated task.");
    await nested.waitForIdle();
    host.signal.removeEventListener("abort", onAbort);
    const error = nested.state.errorMessage;
    if (error) {
      const message = sanitizeError(error);
      host.queue.push({ type: "subagent", agentId, name, task, status: "failed", result: message });
      return `Subagent failed: ${message}`;
    }
    const result = streamed || assistantText(nested.state.messages.at(-1)) || "done.";
    const clipped = result.length > 12_000 ? `${result.slice(0, 12_000)}…` : result;
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "completed",
      result: clipped,
    });
    return clipped;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({ type: "subagent", agentId, name, task, status: "failed", result: message });
    return `Subagent failed: ${message}`;
  } finally {
    host.nestedAgents.delete(nested);
    host.subagentGate.release();
  }
}

function parametersFor(tool: ConnectorTool) {
  if (tool.name === "write_file") {
    return Type.Object({ path: Type.String(), content: Type.String() });
  }
  if (tool.name === "destination.write") {
    return Type.Object({
      collection: Type.String(),
      title: Type.String(),
      body: Type.String(),
    });
  }
  if (tool.name === "request_takeover") {
    return Type.Object({ reason: Type.String() });
  }
  if (tool.name === "remember") {
    return Type.Object({ content: Type.String(), path: Type.String() });
  }
  if (tool.name === "shell") {
    return Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "run_subagent") {
    return Type.Object({
      name: Type.String(),
      task: Type.String(),
      instructions: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "spawn_bot") {
    return Type.Object({
      name: Type.String(),
      title: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    });
  }
  if (tool.name === "delete_bot") {
    return Type.Object({
      confirm_name: Type.String(),
      bot_id: Type.Optional(Type.String()),
    });
  }
  return jsonSchemaParameters(tool.inputSchema);
}

/** Keep recent visual state without repeatedly resending every earlier full screenshot. */
export function pruneComputerScreenshotContext(
  messages: AgentMessage[],
  screenshotsToKeep = 2,
): AgentMessage[] {
  let remaining = Math.max(0, screenshotsToKeep);
  let transformed: AgentMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isComputerScreenshotMessage(message)) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: message.content.filter((part) => part.type !== "image"),
    };
  }
  return transformed ?? messages;
}

function isComputerScreenshotMessage(
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "toolResult" }> {
  if (message?.role !== "toolResult" || !message.content.some((part) => part.type === "image")) {
    return false;
  }
  const details = message.details;
  return Boolean(
    details &&
      typeof details === "object" &&
      "frameId" in details &&
      typeof (details as { frameId?: unknown }).frameId === "string",
  );
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

function jsonSchemaParameters(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const field = jsonField(spec);
    fields[key] = (required.has(key) ? field : Type.Optional(field)) as unknown as ReturnType<
      typeof Type.Optional
    >;
  }
  return Type.Object(fields);
}

function jsonField(spec: unknown): ReturnType<typeof Type.String> {
  const definition = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  if (Array.isArray(definition.enum) && definition.enum.length > 0) {
    return Type.Union(definition.enum.map((value) => Type.Literal(value))) as never;
  }
  const type = "type" in definition ? String(definition.type) : "string";
  if (type === "number" || type === "integer") return Type.Number() as never;
  if (type === "boolean") return Type.Boolean() as never;
  if (type === "array") return Type.Array(jsonField(definition.items)) as never;
  if (type === "object") return jsonSchemaParameters(definition) as never;
  return Type.String();
}

function summarizeToolResult(result: unknown) {
  try {
    const text = JSON.stringify(result);
    if (!text) return "ok";
    return text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text;
  } catch {
    return "ok";
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

function sanitizeError(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]");
}

interface EventQueue {
  push(event: AgentRuntimeEvent): void;
  close(): void;
  iterate(): AsyncIterable<AgentRuntimeEvent>;
}

interface ToolHost {
  queue: EventQueue;
  request: AgentRunRequest;
  models: Models;
  model: Model<Api>;
  apiKey: string | undefined;
  nestedAgents: Set<Agent>;
  subagentGate: { acquire(): Promise<void>; release(): void };
  signal: AbortSignal;
  depth: number;
}

function createGate(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (active >= max) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

function createQueue(): EventQueue {
  const items: AgentRuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event) {
      items.push(event);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *iterate() {
      while (!closed || items.length) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
