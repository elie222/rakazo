import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";

/** Compatibility target from the original prototype, NOT a production-approved version. */
export const CODEX_PROTOCOL_VERSION = "0.162.1";

/**
 * Private app-server boundary. A future transport must bound JSON frames, correlate RPC
 * replies, reject RPC errors, and interrupt pending reads/requests on signal abortion.
 * close() must terminate the whole process tree, even when iteration stops early.
 * This interface does not confer isolation and is deliberately not registered as a runtime.
 */
export interface CodexProtocolChannel {
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  send(message: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  messages(signal: AbortSignal): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface CodexTextTurn {
  runId: string;
  model: string;
  instructions: string;
  prompt: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid app-server object.");
  }
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid app-server identity.");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid app-server usage.");
  }
  return value;
}

/**
 * Text-only protocol experiment, no spawn, authentication, tools, native sessions or
 * production entry point. `environments: []` and refusal are defense in depth only:
 * a tool lifecycle notification could arrive AFTER an action has already happened.
 */
export async function* runCodexTextProtocol(
  channel: CodexProtocolChannel,
  input: CodexTextTurn,
  signal: AbortSignal,
): AsyncGenerator<AgentRuntimeEvent> {
  try {
    signal.throwIfAborted();
    await channel.request(
      "initialize",
      {
        clientInfo: { name: "rakazo", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
      signal,
    );
    await channel.send({ method: "initialized" }, signal);
    const started = object(
      await channel.request(
        "thread/start",
        {
          model: input.model,
          modelProvider: "rakazo",
          baseInstructions: input.instructions,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          environments: [],
          dynamicTools: [],
          ephemeral: true,
        },
        signal,
      ),
    );
    const threadId = identity(object(started.thread).id);
    const turn = object(
      await channel.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: input.prompt, textElements: [] }],
          environments: [],
        },
        signal,
      ),
    );
    const turnId = identity(object(turn.turn).id);
    let text = "";
    let finalText = "";
    let streamed = false;
    let usage:
      | { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }
      | undefined;
    for await (const raw of channel.messages(signal)) {
      signal.throwIfAborted();
      const message = object(raw);
      const method = identity(message.method);
      // No native request (including approval and dynamic tools) is ever accepted.
      if (message.id !== undefined) {
        await channel.send(
          { id: message.id, error: { code: -32601, message: "Request denied." } },
          signal,
        );
        throw new Error("App-server requested an unsupported operation.");
      }
      const p = object(message.params);
      if (p.threadId !== threadId || (p.turnId !== undefined && p.turnId !== turnId)) {
        throw new Error("App-server run identity mismatch.");
      }
      if (method === "item/agentMessage/delta") {
        if (p.turnId !== turnId || typeof p.delta !== "string")
          throw new Error("Invalid text delta.");
        text += p.delta;
        if (text.length > 1_000_000) throw new Error("App-server text limit exceeded.");
        streamed = true;
        yield { type: "text", text: p.delta };
      } else if (method === "item/started" || method === "item/completed") {
        const item = object(p.item);
        if (!["userMessage", "agentMessage", "reasoning"].includes(String(item.type))) {
          throw new Error("App-server surfaced an unsupported item.");
        }
        if (!streamed && method === "item/completed" && item.type === "agentMessage") {
          if (typeof item.text !== "string") throw new Error("Invalid final text.");
          finalText += item.text;
          if (finalText.length > 1_000_000) throw new Error("App-server text limit exceeded.");
        }
      } else if (method === "thread/tokenUsage/updated") {
        const total = object(object(p.tokenUsage).total);
        const inputTokens = count(total.inputTokens);
        const cacheReadTokens = count(total.cachedInputTokens);
        const outputTokens = count(total.outputTokens);
        const totalTokens = count(total.totalTokens);
        if (
          cacheReadTokens > inputTokens ||
          totalTokens < inputTokens + outputTokens ||
          (usage &&
            (inputTokens < usage.inputTokens + usage.cacheReadTokens ||
              outputTokens < usage.outputTokens))
        ) {
          throw new Error("Inconsistent app-server usage.");
        }
        usage = {
          inputTokens: inputTokens - cacheReadTokens,
          outputTokens,
          cacheReadTokens,
          totalTokens,
        };
      } else if (method === "turn/completed") {
        const terminal = object(p.turn);
        if (terminal.id !== turnId || terminal.status !== "completed" || terminal.error) {
          throw new Error("App-server turn did not complete successfully.");
        }
        if (!streamed) text = finalText;
        if (!streamed && text) yield { type: "text", text };
        yield {
          type: "usage",
          provider: "openai",
          model: input.model,
          inputTokens: null,
          outputTokens: null,
          ...usage,
          costUsd: null,
          usageSource: "codex-app-server",
          callId: `${input.runId}:${turnId}`,
        };
        yield { type: "done", text };
        return;
      } else if (method !== "turn/started" && method !== "thread/started") {
        // Unknown protocol features fail closed rather than being silently ignored.
        throw new Error("Unsupported app-server notification.");
      }
    }
    throw new Error("App-server ended without an explicit terminal result.");
  } finally {
    await channel.close();
  }
}
