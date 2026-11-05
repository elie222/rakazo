import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";
import type { RuntimeContextDecision } from "./runtime-context.js";
import { formatTurnMemoryContext } from "./turn-memory-prompt.js";

type WireMessage = { role: string; content: string | Array<{ text?: string }> };

function historicalTurns(): AgentRunRequest["history"] {
  return Array.from({ length: 12 }, (_, exchange) =>
    (["user", "assistant"] as const).map((role) => ({
      id: `${role}-${exchange}`,
      role,
      content: `Earlier ${role} exchange ${exchange}: ${"Synthetic earlier evidence. ".repeat(180)}`,
    })),
  ).flat();
}

function turnMemory() {
  return formatTurnMemoryContext({
    sections: [
      {
        id: "procedure-section",
        layer: "procedure",
        content: "1. Inspect the synthetic ledger.\n2. Reconcile the entries.",
        sourceMemoryIds: ["procedure-memory"],
      },
      {
        id: "policy-section",
        layer: "policy",
        content: "Prefer metric units.",
        sourceMemoryIds: ["policy-memory"],
      },
      {
        id: "environment-section",
        layer: "environment",
        content: "The synthetic project deploys from main.",
        sourceMemoryIds: ["environment-memory"],
      },
      {
        id: "episode-section",
        layer: "episode",
        content: "The last completed reconciliation used the synthetic ledger.",
        sourceMemoryIds: ["episode-memory"],
      },
    ],
    sourceMemoryIds: ["procedure-memory", "policy-memory", "environment-memory", "episode-memory"],
  });
}

function request(history: AgentRunRequest["history"]): AgentRunRequest {
  return {
    botId: "bot-fixture",
    threadId: "turn-memory-context-fixture",
    runId: "run-fixture",
    prompt: "Inspect the current synthetic ledger, without changing it.",
    instructions: "Answer briefly and follow the current request.",
    history,
    tools: ["read_history", "search_history"].map((name) => ({
      name,
      description: "Read synthetic historical evidence.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    })),
    executeTool: async () => {
      throw new Error("The synthetic completion must not execute tools");
    },
    model: {
      provider: "openai-compatible",
      id: "fixture",
      baseUrl: "http://127.0.0.1:9/v1",
      allowPrivateEndpoint: true,
      contextWindow: 65_536,
      maxTokens: 1024,
    },
  };
}

/** Records serialized provider requests; the real runtime and selection policy are not mocked. */
async function modelRequest(input: AgentRunRequest) {
  const bodies: Array<{ messages: WireMessage[] }> = [];
  const decisions: RuntimeContextDecision[] = [];
  const runtime = new PiAgentRuntime({
    modelFetch: async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:9/v1/chat/completions");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Ready." }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 3, total_tokens: 1003 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    onContextDecision: (decision) => decisions.push(decision),
  });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input, { signal: AbortSignal.timeout(15_000) }))
    events.push(event);
  expect(events.at(-1)).toEqual({ type: "done", text: "Ready." });
  expect(bodies).toHaveLength(1);
  expect(decisions).toHaveLength(1);
  return { messages: bodies[0]!.messages, decision: decisions[0]! };
}

const text = (message: WireMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");

describe("turn memory in the runtime model request", () => {
  it.each([undefined, "retrieval", "snapshots"] as const)(
    "retains rendered turn memory beyond eight exchanges under %s selection",
    async (contextStrategy) => {
      const rendered = turnMemory();
      expect(rendered.injectedIds).toEqual([
        "procedure-memory",
        "policy-memory",
        "environment-memory",
        "episode-memory",
      ]);
      const history = historicalTurns();
      const input = request([{ role: "user", content: rendered.text }, ...history]);
      input.contextStrategy = contextStrategy;

      const { messages, decision } = await modelRequest(input);
      const memoryMessages = messages.filter((message) => text(message).includes("<turn_memory>"));
      expect(memoryMessages).toHaveLength(1);
      expect(memoryMessages[0]!.role).toBe("user");
      expect(text(memoryMessages[0]!)).toContain(rendered.text);
      expect(
        messages
          .filter((message) => message.role === "system")
          .map(text)
          .join("\n"),
      ).not.toContain("<turn_memory>");
      expect(text(messages.at(-1)!)).toBe(input.prompt);
      const sent = messages.map(text).join("\n");
      expect(sent).not.toContain(history[0]!.content);
      expect(sent).toContain(history.at(-2)!.content);
      expect(sent).toContain(history.at(-1)!.content);
      expect(decision.strategy).toBe(contextStrategy ?? DEFAULT_CONTEXT_STRATEGY);
      expect(decision.droppedMessages).toBeGreaterThan(0);
      expect(decision.estimatedInputTokens).toBeLessThanOrEqual(65_536 - 1024);
      if (contextStrategy === "snapshots")
        expect(sent).toContain("Historical navigation snapshots");
    },
  );
});
