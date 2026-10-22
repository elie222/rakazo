import { once } from "node:events";
import { createServer } from "node:http";
import type { AgentRuntimeEvent, AgentToolExecutionObserver } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

it("marks the reply to a finished shell as a new assistant message", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const body =
      calls === 1
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "shell-1",
                  type: "function",
                  function: { name: "shell", arguments: '{"command":"long-job"}' },
                },
              ],
            },
            "tool_calls",
          )
        : calls === 2
          ? chunk({ role: "assistant", content: "Started" }) +
            chunk({ content: " the job." }, "stop")
          : chunk({ role: "assistant", content: "It finished." }, "stop");
    response.end(`${body}data: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  const executeTool = async (
    _name: string,
    _args: Record<string, unknown>,
    _executionId: string,
    _route: unknown,
    observer?: AgentToolExecutionObserver,
  ) => {
    observer?.onShellStillRunning?.(Promise.resolve({ stdout: "ok", stderr: "", code: 0 }));
    return { stdout: "", stderr: "", code: null, running: true };
  };
  const events: AgentRuntimeEvent[] = [];
  try {
    for await (const event of new PiAgentRuntime().run(
      {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "fixture-run",
        prompt: "Start the long job.",
        instructions: "Fixture",
        history: [],
        tools: [
          {
            name: "shell",
            description: "Run a command",
            inputSchema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
        executeTool,
        model: {
          provider: "openai-compatible",
          id: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          allowPrivateEndpoint: true,
        },
      },
      { signal: AbortSignal.timeout(15_000) },
    )) {
      events.push(event);
    }
    expect(calls).toBe(3);
    expect(
      events.flatMap((event) =>
        event.type === "text" ? [event.text] : event.type === "turn" ? ["<turn>"] : [],
      ),
    ).toEqual(["Started", " the job.", "<turn>", "It finished."]);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});
