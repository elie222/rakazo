import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { createTextRuntime } from "./runtime.js";

function request(runId: string, apiKey: string): AgentRunRequest {
  return {
    botId: runId,
    threadId: runId,
    runId,
    prompt: "Current DM",
    instructions: "You are the selected bot.",
    history: [{ role: "assistant", content: "Earlier answer" }],
    tools: [],
    model: { provider: "anthropic", id: "claude-sonnet-4-6", apiKey },
  };
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}

it("runs the pinned SDK against an offline API with separate per-run keys and no tools", async () => {
  const seen: Array<{ key: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const key = req.headers["x-api-key"];
    seen.push({ key: typeof key === "string" ? key : undefined, body: JSON.parse(body) });
    const message = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 0 },
    };
    const events = [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Offline reply." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Fixture listener is unavailable");
    const runtime = createTextRuntime((options) =>
      spawn(options.command, options.args, {
        cwd: options.cwd,
        env: { ...options.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}` },
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const results = await Promise.all([
      collect(runtime.run(request("bot-a", "fixture-key-a"))),
      collect(runtime.run(request("bot-b", "fixture-key-b"))),
    ]);
    expect(seen.map((item) => item.key).sort()).toEqual(["fixture-key-a", "fixture-key-b"]);
    for (const { body } of seen) {
      expect(body.tools ?? []).toEqual([]);
      expect(JSON.stringify(body.messages)).toContain("Earlier answer");
      expect(JSON.stringify(body.messages)).toContain("Current DM");
    }
    for (const result of results) {
      expect(result).toContainEqual({ type: "text", text: "Offline reply." });
      expect(result).toContainEqual(
        expect.objectContaining({ type: "usage", inputTokens: 8, outputTokens: 4 }),
      );
      expect(result.at(-1)).toEqual({ type: "done" });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);

it("does not start a process for an already cancelled run", async () => {
  const controller = new AbortController();
  const start = vi.fn(() => {
    throw new Error("unexpected spawn");
  });
  controller.abort();
  expect(
    await collect(
      createTextRuntime(start).run(request("cancelled", "fixture-key"), {
        signal: controller.signal,
      }),
    ),
  ).toEqual([]);
  expect(start).not.toHaveBeenCalled();
});

it("stops the actual SDK while the upstream request is still open", async () => {
  let sawRequest = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/v1/messages")) {
      sawRequest = true;
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Fixture listener is unavailable");
    const runtime = createTextRuntime((options) =>
      spawn(options.command, options.args, {
        cwd: options.cwd,
        env: { ...options.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}` },
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const events = collect(runtime.run(request("stopped", "fixture-key")));
    await vi.waitFor(() => expect(sawRequest).toBe(true), 5_000);
    await runtime.abort("stopped");
    await expect(events).resolves.toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);
