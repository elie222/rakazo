import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { abortableDelay, pollUntil } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import { isTerminatingReplyResult, terminatingReplyText } from "../../approvals/approval-effect.js";
import { cliEnv, privateFolder } from "../../cli-models/cli-process.js";
import type { PersonalCliAccessCheck } from "../../cli-models/personal-access.js";
import { deliverFinishedShells } from "../../computers/sandbox/shell-command-stream.js";
import { sanitizeSensitiveText } from "../pi/pi-runtime-errors.js";
import { modelStreamIdleTimeoutMs } from "../pi/pi-runtime-limits.js";
import { createRuntimeModels } from "../pi/pi-runtime-models.js";
import { COMPUTER_MODE_TOOLS } from "../pi/tools/pi-runtime-computer-mode.js";
import type { ToolHost } from "../pi/tools/pi-runtime-tools.js";
import {
  createQueue,
  releaseToolCallBudget,
  toAgentTools,
  toolCallBudgetExceededMessage,
  toolCallBudgetFor,
} from "../pi/tools/pi-runtime-tools.js";
import { fallbackSystemPrompt } from "../runtime.prompt.js";
import type { AcpAgentDescriptor } from "./acp-agent.js";
import type { AcpConnection } from "./acp-connection.js";
import { AcpRequestError, startAcpAgent } from "./acp-connection.js";
import type { AgentSession } from "./acp-sessions.js";
import {
  claimSession,
  findSession,
  forgetSession,
  keepSession,
  noteReplyElsewhere,
  releaseSession,
  sessionKey,
  takeReplyElsewhere,
} from "./acp-sessions.js";
import { startToolServer } from "./acp-tool-server.js";
import {
  conversationBlock,
  historyLine,
  OWN_SPEAKER,
  PERSON_SPEAKER,
  unknownToolText,
} from "./acp-turn.prompt.js";

/** The MCP server name the CLI sees Rakazo's tools under. */
export const ACP_TOOL_SERVER = "rakazo";

/** Screen work needs computer mode, which a CLI-run bot does not have yet. */
const UNSUPPORTED_TOOLS = new Set([
  ...COMPUTER_MODE_TOOLS,
  "enter_computer_mode",
  "leave_computer_mode",
]);

/** JSON-RPC's invalid-params code, which agents answer an unknown session id with. */
const INVALID_PARAMS = -32602;
/** The ACP protocol version this client speaks. */
const PROTOCOL_VERSION = 1;
/** How many of its own replies a session remembers, to tell them from replies written elsewhere. */
const MAX_REMEMBERED_REPLIES = 200;
/** How much of the chat a new session is given, newest first, in characters. */
const SEED_CHARS = 32_000;
/** How long a turn that ends early waits for the CLI to settle its cancelled prompt. */
const CANCEL_GRACE_MS = 3_000;

const agentFolder = privateFolder("rakazo-agent-cli", false);

let toolHostModels: Models | undefined;

type Update = Record<string, unknown>;

interface AcpAgentRuntimeOptions {
  accessCheck?: PersonalCliAccessCheck;
}

/**
 * Runs the turns of the deployment model `descriptor` names through that agent CLI over the Agent
 * Client Protocol; every other model keeps running on `fallback`. The CLI runs the bot's loop with
 * its own tools off: it gets Rakazo's instructions as its system prompt and Rakazo's tools through
 * a loopback MCP endpoint, where each call runs the way any Rakazo tool call runs, approvals and
 * pauses included. Rakazo stores and shows the chat as it does for any bot.
 */
export function acpAgentRuntime(
  fallback: AgentRuntime,
  descriptor: AcpAgentDescriptor,
  options: AcpAgentRuntimeOptions = {},
): AgentRuntime {
  const running = new Map<string, AbortController>();
  const runtime: AgentRuntime = {
    describe: () => fallback.describe(),
    async abort(runId) {
      running.get(runId)?.abort();
      await fallback.abort(runId);
    },
    async *run(request, context) {
      if (request.model.provider !== descriptor.id) {
        yield* fallback.run(request, context);
        return;
      }
      const queue = createQueue();
      const controller = new AbortController();
      running.set(request.runId, controller);
      const signal = context?.signal
        ? AbortSignal.any([context.signal, controller.signal])
        : controller.signal;
      const turn = runAcpTurn(descriptor, request, context, signal, queue.push, options).then(
        () => queue.close(),
        (error: unknown) => queue.fail(error instanceof Error ? error : new Error(String(error))),
      );
      let started = false;
      let failure: unknown;
      try {
        for await (const event of queue.iterate()) {
          started = true;
          yield event;
        }
      } catch (error) {
        failure = error;
      } finally {
        // The consumer stops reading at a pause or a stop; the CLI goes with it.
        controller.abort();
        await turn;
        if (running.get(request.runId) === controller) running.delete(request.runId);
      }
      if (failure === undefined) return;
      // A turn the CLI failed before it produced anything moves to the person's backup model,
      // as a failed model call does in the runtime this one wraps. Using its own tools is not a
      // model failure.
      const [backup, ...rest] = request.fallbackModels ?? [];
      if (
        started ||
        context?.signal?.aborted ||
        failure instanceof OwnToolUseError ||
        !backup ||
        !request.resolveFallbackModel
      ) {
        throw failure;
      }
      getLogger().warn("The agent CLI failed; trying the backup model", {
        agent: descriptor.id,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      const model = await request.resolveFallbackModel(
        backup.provider,
        backup.id,
        backup.connectionId,
      );
      await request.onModelChange?.(model.provider, model.id);
      yield* runtime.run({ ...request, model, fallbackModels: rest }, context);
    },
  };
  return runtime;
}

/** The CLI used a tool of its own, which Rakazo keeps off. */
class OwnToolUseError extends Error {}

class TurnAborted extends Error {}

async function runAcpTurn(
  descriptor: AcpAgentDescriptor,
  request: AgentRunRequest,
  context: Partial<AdapterContext> | undefined,
  signal: AbortSignal,
  push: (event: AgentRuntimeEvent) => void,
  options: AcpAgentRuntimeOptions,
): Promise<void> {
  const refusal = options.accessCheck
    ? await options.accessCheck()
    : `${descriptor.label} runs only inside the Rakazo API and worker.`;
  if (refusal) throw new Error(refusal);
  signal.throwIfAborted();

  // A helper call (a summary, a check, a page revision, a meeting answer) is not a chat turn: it
  // gets a session of its own that is deleted afterwards, and leaves the chat's session alone.
  // Chat turns are answers or background helper runs, and always have tools.
  const oneShot =
    request.tools.length === 0 ||
    (request.usageOperationKind !== "answer" && request.usageOperationKind !== "subagent");
  const key = sessionKey(descriptor.id, request.botId, request.threadId);
  const cwd = join(
    agentFolder(),
    createHash("sha256").update(`${descriptor.id}\0${request.botId}`).digest("hex").slice(0, 24),
  );
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const files = await mkdtemp(join(tmpdir(), "rakazo-agent-cli-turn-"));

  const toolBudget = toolCallBudgetFor(request.runId, 0);
  let connection: AcpConnection | undefined;
  let closeToolServer: (() => Promise<void>) | undefined;
  let sessionId: string | undefined;
  let cancelled = false;
  /** The prompt the CLI is still answering, if the turn ends before it does. */
  let inFlight: Promise<Update> | undefined;
  let sentPrompt = false;
  let replied = false;
  let replyText = "";
  /** A session this turn started, and whether the chat kept it; one it did not keep is removed. */
  let createdSession = false;
  let cachedSession = false;
  /** The chat's session this turn stopped using, which is removed like a helper's. */
  let droppedSession = false;
  /** The final reply a tool that ends the turn carries. */
  let terminatedReply: string | undefined;
  /** The CLI reported something about the new message, so it has it. */
  let promptHeard = false;
  let violation: Error | undefined;
  /** How the CLI removes a session, where it can. */
  let endSession: string | undefined;
  const cancelTurn = () => {
    if (cancelled || !connection || !sessionId) return;
    cancelled = true;
    connection.notify("session/cancel", { sessionId });
  };
  // Two turns of one chat at once (a group chat can run several) must not share a session: the
  // second gets one of its own from the chat history, removed afterwards like a helper's.
  const ownsChatSession = !oneShot && claimSession(key);
  // Taken as the turn starts: only replies written before then can be in its history.
  const includeOwnReplies = ownsChatSession && takeReplyElsewhere(key);
  const disposable = !ownsChatSession;
  const known = ownsChatSession ? findSession(key) : undefined;
  try {
    const host = toolHost(request, context, signal, push, cancelTurn, toolBudget);
    const agentTools = toAgentTools(
      request.tools.filter((tool) => !UNSUPPORTED_TOOLS.has(tool.name)),
      host,
    );
    const byName = new Map(agentTools.map((tool) => [tool.name, tool]));
    const ownToolCalls = new Set(
      agentTools.map((tool) => descriptor.toolCallName(ACP_TOOL_SERVER, tool.name)),
    );
    let toolsRunning = 0;
    let quietSince = Date.now();
    let afterTool = false;
    let thinking = false;
    let replaying = false;

    // One call at a time, as Rakazo's tools expect where one call can change what the next acts on
    // or pause the turn.
    let toolsDone: Promise<unknown> = Promise.resolve();
    const callTool = (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const call = toolsDone.then(() => runTool(name, args));
      toolsDone = call;
      return call;
    };
    const runTool = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      const tool = byName.get(name);
      if (!tool) return errorResult(unknownToolText(name));
      toolsRunning += 1;
      afterTool = true;
      try {
        const id = randomUUID();
        const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
        const validated = validateToolArguments(tool as never, {
          type: "toolCall",
          id,
          name,
          arguments: prepared as never,
        });
        const result = await tool.execute(id, validated, signal);
        let finished: string | undefined;
        await deliverFinishedShells(
          (text) => {
            finished = text;
          },
          host.pendingShells,
          { toolResults: [{ toolName: name, details: result?.details }] },
          signal,
        );
        if (isTerminatingReplyResult(result)) {
          terminatedReply = terminatingReplyText(result) ?? terminatedReply;
        }
        return toolResult(result, finished);
      } catch (error) {
        return errorResult(
          sanitizeSensitiveText(error instanceof Error ? error.message : String(error)),
        );
      } finally {
        toolsRunning -= 1;
        quietSince = Date.now();
      }
    };

    const refuse = (reason: string) => {
      violation ??= new OwnToolUseError(
        `${descriptor.label} tried to use its own tools (${reason}), which Rakazo keeps off. The turn was stopped.`,
      );
      cancelTurn();
      // After any answer the agent is owed has gone out.
      setImmediate(() => connection?.stop());
    };

    const onUpdate = (update: Update) => {
      if (replaying) return;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = textOf(update.content);
          if (!text) return;
          if (afterTool) {
            afterTool = false;
            // A later reply supersedes what a turn-ending tool carried.
            terminatedReply = undefined;
            host.modelResponses = (host.modelResponses ?? 0) + 1;
            push({ type: "turn" });
          }
          thinking = false;
          push({ type: "text", text });
          replyText += text;
          return;
        }
        case "agent_thought_chunk":
          if (!thinking) {
            thinking = true;
            push({ type: "thinking", active: true });
          }
          return;
        case "tool_call":
        case "tool_call_update": {
          const name = descriptor.reportedToolName
            ? descriptor.reportedToolName(update)
            : typeof update.name === "string"
              ? update.name
              : undefined;
          // Every call the CLI reports must be one of Rakazo's; anything else means its own
          // tools were not off after all.
          if (update.sessionUpdate === "tool_call" || name !== undefined) {
            if (!name || !ownToolCalls.has(name)) refuse(name ?? "an unnamed tool");
          }
          return;
        }
      }
    };

    const toolServer = agentTools.length
      ? await startToolServer(
          ACP_TOOL_SERVER,
          agentTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
          })),
          callTool,
        )
      : undefined;
    closeToolServer = toolServer?.close;
    const mcpServers = toolServer ? [toolServer.entry] : [];

    const launch = await descriptor.launch({
      files,
      instructions: request.instructions || fallbackSystemPrompt(false),
      toolServer: ACP_TOOL_SERVER,
      env: cliEnv(process.env),
    });
    signal.throwIfAborted();
    const agent = startAcpAgent(
      descriptor.command,
      launch.args,
      { cwd, env: launch.env },
      {
        onNotification(method, params) {
          if (method === "session/update" && params.sessionId === sessionId) {
            if (inFlight) promptHeard = true;
            const update = params.update;
            if (update && typeof update === "object") onUpdate(update as Update);
          }
        },
        async onRequest(method, params) {
          if (method === "session/request_permission") {
            // Rakazo's own tools are allowed up front, so a request is for one of the CLI's.
            const toolCall = (params.toolCall ?? {}) as Update;
            refuse(String(toolCall.name ?? toolCall.title ?? "a permission request"));
            return { outcome: { outcome: "cancelled" } };
          }
          throw new AcpRequestError(method, -32601, "Method not found");
        },
      },
    );
    connection = agent;
    const step = <T>(work: Promise<T>) =>
      awaitStep(work, agent, signal, descriptor, () => ({
        quiet: toolsRunning === 0,
        since: Math.max(quietSince, agent.lastHeardAt()),
      }));

    const init = await step(
      agent.request<Update>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    );
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `${descriptor.label} speaks Agent Client Protocol version ${String(init.protocolVersion)}, not ${PROTOCOL_VERSION}.`,
      );
    }
    const capabilities = (init.agentCapabilities ?? {}) as Update;
    const sessionCapabilities = (capabilities.sessionCapabilities ?? {}) as Update;
    endSession = sessionCapabilities.delete
      ? "session/delete"
      : sessionCapabilities.close
        ? "session/close"
        : undefined;

    // A session continues where the CLI can resume or load it; otherwise the chat starts over.
    let session =
      known && (sessionCapabilities.resume || capabilities.loadSession) ? known : undefined;
    let opened: Update | undefined;
    if (session) {
      const resume = { sessionId: session.id, cwd: session.cwd, mcpServers };
      try {
        if (sessionCapabilities.resume) {
          opened = await step(agent.request<Update>("session/resume", resume));
        } else {
          // Loading replays the session's history as updates; Rakazo already shows it.
          replaying = true;
          opened = await step(agent.request<Update>("session/load", resume));
        }
        sessionId = session.id;
      } catch (error) {
        // The CLI no longer has the session; anything else ends the turn.
        if (!isMissingSession(error, descriptor)) throw error;
        getLogger().warn("The agent CLI could not continue its session; starting a new one", {
          agent: descriptor.id,
          error: error.message,
        });
        session = undefined;
      } finally {
        replaying = false;
      }
    }
    if (known && !session) forgetSession(key);
    if (!session) {
      opened = await step(agent.request<Update>("session/new", { cwd, mcpServers }));
      if (typeof opened.sessionId !== "string") {
        throw new Error(`${descriptor.label} did not start a session.`);
      }
      sessionId = opened.sessionId;
      createdSession = true;
    }
    const activeSessionId = sessionId!;
    await selectModel(agent, activeSessionId, opened, request.model.id, descriptor, step);

    const fresh = !session;
    const current: AgentSession = session ?? {
      id: activeSessionId,
      cwd,
      seen: new Set(),
      context: new Set(),
      replies: new Set(),
      usedAt: Date.now(),
    };
    const promptText = turnText(request, current, fresh, includeOwnReplies);
    current.usedAt = Date.now();
    if (ownsChatSession) {
      keepSession(key, current);
      cachedSession = true;
    }

    const send = async (text: string) => {
      const prompting = agent.request<Update>("session/prompt", {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text }],
      });
      inFlight = prompting;
      sentPrompt = true;
      try {
        return await step(prompting);
      } catch (error) {
        if (violation) throw violation;
        throw error;
      } finally {
        if (inFlight === prompting) inFlight = undefined;
      }
    };
    let response = await send(promptText);
    // Shell commands still running when the CLI ended its turn report back, as between steps.
    while (!violation && !cancelled && host.pendingShells.length) {
      let finished: string | undefined;
      await deliverFinishedShells(
        (text) => {
          finished = text;
        },
        host.pendingShells,
        { toolResults: [] },
        signal,
      );
      if (!finished) break;
      await reportUsage(request, descriptor, response.usage, push);
      afterTool = true;
      response = await send(finished);
    }
    if (violation) throw violation;
    const stopReason = response.stopReason;
    // The CLI did the model work whatever the stop, so its usage is recorded first.
    await reportUsage(request, descriptor, response.usage, push);
    if (stopReason === "refusal") throw new Error(`${descriptor.label} refused to answer.`);
    if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      throw new Error(`${descriptor.label} reached its output limit before it finished.`);
    }
    // Only a finished turn, or one Rakazo cancelled itself, is complete.
    if (stopReason !== "end_turn" && !(stopReason === "cancelled" && cancelled)) {
      throw new Error(`${descriptor.label} stopped the turn before it finished.`);
    }
    // A call the CLI was cancelled during still settles its result, which may carry the reply.
    await toolsDone;
    // The same endings as a turn in the runtime this one wraps.
    const ending = toolBudget.exceeded
      ? toolCallBudgetExceededMessage(toolBudget.limit)
      : !host.pausePending && terminatedReply
        ? terminatedReply
        : !host.pausePending && !replyText.trim() && !request.allowSilentEmpty
          ? request.emptyResponseText?.trim() || "No response. Try again."
          : undefined;
    if (ending) {
      const text = replyText.trim() ? `\n\n${ending}` : ending;
      push({ type: "text", text });
      replyText += text;
    }
    replied = true;
    // So the chat's session can tell its own replies from those written elsewhere.
    if (replyText.trim()) {
      current.replies.add(contentHash(replyText.trim()));
      // The newest replies are the ones the chat's history still holds.
      while (current.replies.size > MAX_REMEMBERED_REPLIES) {
        current.replies.delete(current.replies.values().next().value!);
      }
    }
    // Helpers read the answer from here.
    push(replyText.trim() ? { type: "done", text: replyText } : { type: "done" });
  } catch (error) {
    if (error instanceof TurnAborted || (signal.aborted && !violation)) {
      // Stopped before the CLI said anything about the new message: it may never have received
      // it, so the next turn starts over from the chat rather than skip what it was sent.
      if (ownsChatSession && sentPrompt && !promptHeard) {
        forgetSession(key);
        droppedSession = true;
      }
      return;
    }
    // A failed turn may have left the session short of what it was sent, so the next turn
    // starts over from the chat. A helper never used the chat's session.
    if (ownsChatSession && sentPrompt) {
      forgetSession(key);
      droppedSession = true;
    }
    if (violation) throw violation;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(descriptor.notInstalled);
    }
    if (error instanceof AcpRequestError) {
      throw new Error(`${descriptor.label} error: ${sanitizeSensitiveText(error.message)}`);
    }
    throw error;
  } finally {
    releaseToolCallBudget(request.runId, false);
    // A turn that ended before sending its message leaves the note for the next one.
    if (includeOwnReplies && !sentPrompt) noteReplyElsewhere(key);
    // A turn beside the chat's own wrote a reply its session never saw; the next turn sends it.
    if (!ownsChatSession && !oneShot && replied) noteReplyElsewhere(key);
    if (connection) {
      // Give a cancelled turn a moment to settle so the CLI saves the session cleanly.
      if (inFlight && sessionId) {
        if (!cancelled) connection.notify("session/cancel", { sessionId });
        const grace = new AbortController();
        const settled = await Promise.race([
          inFlight.then(
            (response) => response,
            () => undefined,
          ),
          abortableDelay(CANCEL_GRACE_MS, grace.signal),
        ]);
        grace.abort();
        // The CLI did the model work even when the turn ended at a pause or a stop.
        await bestEffort(
          "Record the agent CLI's usage",
          reportUsage(request, descriptor, (settled as Update | undefined)?.usage, push),
        );
      }
      // A helper's or a parallel turn's session, or one never kept, is removed however the turn ended.
      if (
        (disposable || droppedSession || (createdSession && !cachedSession)) &&
        sessionId &&
        endSession
      ) {
        const ending = bestEffort(
          "Remove the agent CLI's helper session",
          connection.request(endSession, { sessionId }),
        );
        await Promise.race([ending, abortableDelay(CANCEL_GRACE_MS)]);
      }
      connection.stop();
    }
    await closeToolServer?.();
    // Only once the CLI is gone may the chat's next turn continue its session.
    if (ownsChatSession) releaseSession(key);
    await bestEffort(
      "Remove the agent CLI's turn files",
      rm(files, { recursive: true, force: true }),
    );
  }
}

/** Waits for one exchange with the CLI, failing when it exits, goes quiet, or the turn stops. */
async function awaitStep<T>(
  work: Promise<T>,
  agent: AcpConnection,
  signal: AbortSignal,
  descriptor: AcpAgentDescriptor,
  activity: () => { quiet: boolean; since: number },
): Promise<T> {
  const idleMs = modelStreamIdleTimeoutMs();
  const done = new AbortController();
  let onAbort: (() => void) | undefined;
  // A long silence while no tool is running means the CLI is stuck. The watch ends with the step.
  const stalled =
    idleMs > 0
      ? pollUntil(
          () => {
            if (done.signal.aborted) return true;
            const { quiet, since } = activity();
            return quiet && Date.now() - since > idleMs;
          },
          {
            intervalMs: Math.min(1_000, idleMs),
            timeoutMs: Number.POSITIVE_INFINITY,
            waitingFor: "the agent CLI to go quiet",
          },
        ).then(() => {
          if (!done.signal.aborted) {
            throw new Error(`${descriptor.label} stopped responding. Try again.`);
          }
          return new Promise<never>(() => {});
        })
      : new Promise<never>(() => {});
  try {
    return await Promise.race([
      work,
      agent.exited.then((reason) => {
        const stderr = sanitizeSensitiveText(agent.stderrTail()).slice(-500);
        throw signal.aborted
          ? new TurnAborted()
          : (reason as NodeJS.ErrnoException).code === "ENOENT"
            ? reason
            : new Error(
                `${descriptor.label} ${reason.message} before it finished.${stderr ? ` ${stderr}` : ""}`,
              );
      }),
      stalled,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new TurnAborted());
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    done.abort();
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Chooses the deployment model when the CLI offers a model choice for the session. */
async function selectModel(
  agent: AcpConnection,
  sessionId: string,
  opened: Update | undefined,
  modelId: string,
  descriptor: AcpAgentDescriptor,
  step: <T>(work: Promise<T>) => Promise<T>,
): Promise<void> {
  const options = Array.isArray(opened?.configOptions) ? (opened.configOptions as Update[]) : [];
  const choice = options.find((option) => option.category === "model" || option.id === "model");
  // Running on whatever the CLI defaults to would spend the plan on a model nobody chose.
  if (!choice) throw new Error(`${descriptor.label} offers no model choice for its sessions.`);
  if (choice.currentValue === modelId) return;
  const values = flattenValues(choice.options);
  if (values.length && !values.includes(modelId)) {
    throw new Error(
      `${descriptor.label} on this server has no model "${modelId}". Set PI_DEFAULT_MODEL to one it lists.`,
    );
  }
  await step(
    agent.request("session/set_config_option", {
      sessionId,
      configId: choice.id,
      value: modelId,
    }),
  );
}

function flattenValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: Update) =>
    Array.isArray(option?.options)
      ? flattenValues(option.options)
      : typeof option?.value === "string"
        ? [option.value]
        : [],
  );
}

/**
 * This turn's message: the chat the session has not seen, then the new message. A new session
 * gets the newest part of the chat that fits; a continued one only what others wrote since.
 */
function turnText(
  request: AgentRunRequest,
  session: AgentSession,
  fresh: boolean,
  includeOwn: boolean,
): string {
  const lines: string[] = [];
  for (const item of request.history) {
    const content = item.content.trim();
    // The new message itself goes last, as the prompt.
    if (!content || (item.id && item.id === request.sourceMessageId)) continue;
    const own = item.role === "assistant" && !item.speaker;
    if (item.id) {
      if (session.seen.has(item.id)) continue;
      session.seen.add(item.id);
      // The session wrote this reply itself, unless a turn running beside it did.
      if (own && !fresh && (!includeOwn || session.replies.has(contentHash(content)))) continue;
    } else {
      const hash = contentHash(content);
      if (session.context.has(hash)) continue;
      session.context.add(hash);
    }
    const speaker =
      item.speaker ?? (own ? OWN_SPEAKER : item.role === "system" ? "Note" : PERSON_SPEAKER);
    lines.push(historyLine(speaker, content));
  }
  if (request.sourceMessageId) session.seen.add(request.sourceMessageId);
  // As with ids: only summaries and recall still in this turn's history can come up again.
  const inContext = new Set(
    request.history.filter((item) => !item.id).map((item) => contentHash(item.content.trim())),
  );
  for (const hash of session.context) if (!inContext.has(hash)) session.context.delete(hash);
  // Only ids still in the chat's history window can come up again, so the rest are let go.
  const inWindow = new Set(request.history.map((item) => item.id).filter(Boolean));
  for (const id of session.seen) {
    if (!inWindow.has(id) && id !== request.sourceMessageId) session.seen.delete(id);
  }
  let kept = lines;
  if (fresh) {
    // The newest messages that fit; the newest one is kept, shortened, even when it alone does not.
    let size = 0;
    const start = lines.findLastIndex((line) => {
      size += line.length;
      return size > SEED_CHARS;
    });
    kept =
      start >= 0 && start === lines.length - 1
        ? [`…${lines[start]!.slice(-SEED_CHARS)}`]
        : lines.slice(start + 1);
  }
  const message = request.promptSpeaker
    ? historyLine(request.promptSpeaker, request.prompt)
    : request.prompt;
  return [conversationBlock(kept, fresh), message].filter(Boolean).join("\n\n");
}

/** Usage is reported only when the CLI gives it; the plan pays, so its cost is unknown. */
async function reportUsage(
  request: AgentRunRequest,
  descriptor: AcpAgentDescriptor,
  raw: unknown,
  push: (event: AgentRuntimeEvent) => void,
): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  const count = (name: string) =>
    typeof usage[name] === "number" ? (usage[name] as number) : null;
  const event: Extract<AgentRuntimeEvent, { type: "usage" }> = {
    type: "usage",
    provider: descriptor.id,
    model: request.model.id,
    callId: randomUUID(),
    operationKind: request.usageOperationKind ?? "answer",
    ...(request.model.billing ? { billing: request.model.billing } : {}),
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheReadTokens: count("cachedReadTokens"),
    cacheWriteTokens: count("cachedWriteTokens"),
    reasoningTokens: count("thoughtTokens"),
    totalTokens: count("totalTokens"),
    costUsd: null,
  };
  if (!request.onUsage) {
    push(event);
    return;
  }
  try {
    await request.onUsage(event);
  } catch (error) {
    // As in the runtime this one wraps: the consumer records it instead, and the turn did run.
    push(event);
    throw error;
  }
  push({ ...event, accounted: true });
}

function toolHost(
  request: AgentRunRequest,
  context: Partial<AdapterContext> | undefined,
  signal: AbortSignal,
  push: (event: AgentRuntimeEvent) => void,
  abortTurn: () => void,
  toolCallBudget: ReturnType<typeof toolCallBudgetFor>,
): ToolHost {
  // Tools never call a model through the host; the CLI is the model.
  toolHostModels ??= createRuntimeModels();
  const model = {
    id: request.model.id,
    name: request.model.id,
    api: "acp",
    provider: request.model.provider,
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
  return {
    queue: { push, fail: () => {}, close: () => {}, iterate: () => ({}) as never },
    context,
    request,
    activeModel: {
      config: request.model,
      models: toolHostModels,
      model,
      cardMaxTokens: 0,
      apiKey: undefined,
    },
    models: toolHostModels,
    model,
    apiKey: undefined,
    toolCallBudget,
    toolCallSeq: { value: 0 },
    providerToolCallIds: new Map(),
    abortTurn,
    signal,
    pausePending: false,
    pendingShells: [],
    modelResponses: 0,
  };
}

function textOf(content: unknown): string {
  const block = content as { type?: unknown; text?: unknown } | undefined;
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function toolResult(result: AgentToolResult<unknown>, finishedShells?: string): CallToolResult {
  const content: CallToolResult["content"] = [];
  for (const part of result?.content ?? []) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      content.push({ type: "image", data: part.data, mimeType: part.mimeType });
    }
  }
  if (finishedShells) content.push({ type: "text", text: finishedShells });
  const details = result?.details as { error?: unknown; isError?: unknown } | undefined;
  return {
    content: content.length ? content : [{ type: "text", text: "ok" }],
    ...(details?.error != null || details?.isError === true ? { isError: true } : {}),
  };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Whether the CLI refused a resume because it has no such session: the protocol's invalid-params
 * answer, or a message saying so. Any other error is not a reason to drop the session.
 */
function isMissingSession(
  error: unknown,
  descriptor: AcpAgentDescriptor,
): error is AcpRequestError {
  return (
    error instanceof AcpRequestError &&
    (error.code === INVALID_PARAMS ||
      /not\s*found|no such session|unknown session/i.test(error.message) ||
      descriptor.isMissingSession?.(error) === true)
  );
}
