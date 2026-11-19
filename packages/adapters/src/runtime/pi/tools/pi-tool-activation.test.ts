import type { AgentRunRequest, AgentRuntimeEvent, AgentToolCompletion } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "../../../tools/builtin.tool-definition.js";
import { isDeferredTool } from "../../../tools/builtin-tool-bridge.js";
import { lazyCatalogTools } from "../../../tools/lazy-tool-catalog.js";
import { PiAgentRuntime } from "../pi-runtime.js";
import { activatedTools, toolActivationMode } from "./pi-tool-activation.js";

const catalog = lazyCatalogTools("connectors", "mcp", "MCP");
const executeWrapper = catalog.find((tool) => tool.name === "connectors_execute_tool")!;
const loaded = {
  id: "server-1:send",
  name: "mcp__mail__send",
  description: "Send an email.",
  inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
  readOnly: false,
};

type Call = { name: string; args: Record<string, unknown> };

const sse = (events: Array<{ type: string; [key: string]: unknown }>) =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

/** One Messages API response, as the Claude Code bridge and Anthropic read tools the same way. */
function anthropicReply(call?: Call): Response {
  const block = call
    ? [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_${call.name}`, name: call.name, input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
        },
      ]
    : [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sent." } },
      ];
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** One chat-completions response: a tool call, or the final text when there is none. */
function reply(call?: Call): Response {
  const delta = call
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${call.name}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }
    : { role: "assistant", content: "Sent." };
  const chunks = [
    { id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Runs the scripted calls and records what the provider was offered on each request. */
async function run(calls: Call[], overrides: Partial<AgentRunRequest> = {}) {
  const offered: string[][] = [];
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const completions: AgentToolCompletion[] = [];
  const events: AgentRuntimeEvent[] = [];
  const script = [...calls];
  const runtime = new PiAgentRuntime({
    modelFetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ name?: string; function?: { name: string } }>;
      };
      offered.push((body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? ""));
      return overrides.model?.provider === "anthropic"
        ? anthropicReply(script.shift())
        : reply(script.shift());
    },
  });
  for await (const event of runtime.run(
    {
      botId: "bot",
      threadId: "thread",
      runId: `run-${Math.random()}`,
      prompt: "Email Ann.",
      instructions: "Use tools.",
      history: [],
      tools: catalog,
      model: {
        provider: "openai-compatible",
        id: "fixture",
        baseUrl: "http://127.0.0.1:9/v1",
        allowPrivateEndpoint: true,
        contextWindow: 128_000,
        maxTokens: 1024,
      },
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return name === "connectors_load_tool" ? loaded : { sent: true };
      },
      onToolCompleted: (completion) => {
        completions.push(completion);
      },
      ...overrides,
    },
    {
      operationId: "activation-test",
      traceId: "activation-test",
      spaceId: "space",
      userId: "user",
      signal: new AbortController().signal,
    },
  ))
    events.push(event);
  return { offered, executed, completions, events };
}

const load: Call = { name: "connectors_load_tool", args: { id: "server-1:send" } };
const direct: Call = { name: "mcp__mail__send", args: { to: "ann@example.com" } };

describe("direct tool activation", () => {
  it("is on only for RAKAZO_TOOL_ACTIVATION=direct", () => {
    expect(toolActivationMode({})).toBe("wrapper");
    expect(toolActivationMode({ RAKAZO_TOOL_ACTIVATION: "direct" })).toBe("direct");
  });

  it("activates the built-ins find_tool returned, not ones from a failed call", () => {
    const [found, missed] = builtinAgentTools.filter((tool) => isDeferredTool(tool.name));
    const result = (name: string, isError: boolean) => ({
      role: "toolResult" as const,
      toolCallId: name,
      toolName: "find_tool",
      content: [],
      details: { tools: [{ name }] },
      isError,
      timestamp: 0,
    });
    const activated = activatedTools(
      [result(found!.name, false), result(missed!.name, true)],
      builtinAgentTools,
    );
    expect(activated).toEqual([{ name: found!.name, tool: found }]);
  });

  it("offers a loaded connector tool by name and runs it as the catalog call", async () => {
    const { offered, executed, completions, events } = await run([load, direct], {
      toolActivation: "direct",
    });

    expect(offered[0]).not.toContain("mcp__mail__send");
    expect(offered[1]).toContain("mcp__mail__send");
    expect(offered[1]).toContain("connectors_execute_tool");
    expect(executed[1]).toEqual({
      name: executeWrapper.name,
      args: { id: "server-1:send", arguments: { to: "ann@example.com" } },
    });
    const called = events.flatMap((event) => (event.type === "tool" ? [event.name] : []));
    expect(called).toEqual(["connectors_load_tool", "mcp__mail__send"]);
    expect(completions.map(({ name, error }) => ({ name, failed: error !== undefined }))).toEqual([
      { name: "connectors_load_tool", failed: false },
      { name: "mcp__mail__send", failed: false },
    ]);
  });

  it("offers the loaded tool on the Messages API path too", async () => {
    const { offered, executed } = await run([load, direct], {
      toolActivation: "direct",
      model: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        apiKey: "fixture-key",
        contextWindow: 200_000,
        maxTokens: 1024,
      },
    });

    expect(offered[1]).toContain("mcp__mail__send");
    expect(executed[1]?.name).toBe(executeWrapper.name);
  });

  it("keeps the wrappers only when off, and audits the call it could not find", async () => {
    const { offered, executed, completions } = await run([load, direct]);

    expect(offered[1]).not.toContain("mcp__mail__send");
    expect(executed).toHaveLength(1);
    expect(completions.at(-1)).toMatchObject({ name: "mcp__mail__send", durationMs: 0 });
    expect(String(completions.at(-1)?.error)).toContain("Tool mcp__mail__send not found");
  });
});
