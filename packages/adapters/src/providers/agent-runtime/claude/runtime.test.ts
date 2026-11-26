import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { createTextRuntime } from "./runtime.js";
import type { NativeTextSessionSnapshot, NativeTextSessionTurn } from "./text-session.js";

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

async function offlineApi() {
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
  return { seen, server };
}

it("runs the pinned SDK against an offline API with separate per-run keys and no tools", async () => {
  const { seen, server } = await offlineApi();
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

it("restores an exact native session in a fresh process without replaying app history", async () => {
  const { seen, server } = await offlineApi();
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Fixture listener is unavailable");
  let dropTranscript = false;
  const spawned: Array<{ cwd: string | undefined; pid: number | undefined }> = [];
  const start: Parameters<typeof createTextRuntime>[0] = (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...options.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}` },
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cwd = options.cwd;
    if (dropTranscript && cwd) {
      child.once("exit", () => rmSync(join(cwd, "projects"), { recursive: true, force: true }));
    }
    spawned.push({ cwd, pid: child.pid });
    return child;
  };
  let previous: NativeTextSessionSnapshot | undefined;
  const onCandidate = vi.fn((snapshot: NativeTextSessionSnapshot) => {
    previous = snapshot;
  });
  const scope = {
    spaceId: "space",
    ownerId: "owner",
    profileRevision: "profile-v1",
    mode: "new" as const,
    onCandidate,
  };
  const first = {
    ...request("native-a", "fixture-key"),
    model: {
      ...request("native-a", "fixture-key").model,
      billing: "api_key" as const,
      connectionId: "shared-fixture",
    },
    prompt: "Synthetic first-turn fact: lavender-checkpoint.",
  };
  try {
    expect(await collect(createTextRuntime(start, scope).run(first))).toContainEqual({
      type: "done",
    });
    expect(previous).toBeDefined();
    const snapshot = previous!;
    const second = { ...first, prompt: "Recall the checkpoint.", runId: "native-a-next" };
    expect(
      await collect(
        createTextRuntime(start, { ...scope, mode: "resume", previous: snapshot }).run(second),
      ),
    ).toContainEqual({ type: "done" });
    expect(previous?.sessionId).toEqual(snapshot.sessionId);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]?.cwd).not.toEqual(spawned[1]?.cwd);
    expect(spawned[0]?.pid).not.toEqual(spawned[1]?.pid);
    expect(JSON.stringify(seen[1]?.body.messages)).toContain("lavender-checkpoint");
    expect(JSON.stringify(seen[1]?.body.messages)).toContain("Recall the checkpoint.");
    expect(JSON.stringify(seen[1]?.body.messages)).not.toContain("Earlier answer");
    expect(seen[1]?.body.tools ?? []).toEqual([]);

    for (const [changedRequest, changedScope] of [
      [{ ...second, botId: "different-bot" }, {}],
      [{ ...second, threadId: "different-thread" }, {}],
      [{ ...second, model: { ...second.model, connectionId: "different-connection" } }, {}],
      [{ ...second, model: { ...second.model, apiKey: "rotated-key" } }, {}],
      [second, { ownerId: "different-owner" }],
      [second, { spaceId: "different-space" }],
      [second, { profileRevision: "changed-profile" }],
    ] satisfies [
      AgentRunRequest,
      Partial<Pick<NativeTextSessionTurn, "ownerId" | "spaceId" | "profileRevision">>,
    ][]) {
      await expect(
        collect(
          createTextRuntime(start, {
            ...scope,
            ...changedScope,
            mode: "resume",
            previous: snapshot,
          }).run(changedRequest),
        ),
      ).rejects.toThrow("No other runtime was used");
    }
    await expect(
      collect(
        createTextRuntime(start, {
          ...scope,
          mode: "resume",
          previous: {
            ...snapshot,
            transcript: snapshot.transcript.slice(0, -1),
          },
        }).run(second),
      ),
    ).rejects.toThrow("No other runtime was used");
    await expect(
      collect(
        createTextRuntime(start, {
          ...scope,
          mode: "resume",
          previous: {
            ...snapshot,
            transcript: snapshot.transcript.replace("lavender-checkpoint", "edited-checkpoint"),
          },
        }).run(second),
      ),
    ).rejects.toThrow("No other runtime was used");
    expect(spawned).toHaveLength(2);
    expect(onCandidate).toHaveBeenCalledTimes(2);
    const sharedBot = {
      ...first,
      botId: "native-b",
      threadId: "native-b",
      runId: "native-b",
      prompt: "Separate bot with the same named account.",
    };
    await collect(createTextRuntime(start, scope).run(sharedBot));
    expect(previous?.sessionId).not.toBe(snapshot.sessionId);
    expect(JSON.stringify(seen[2]?.body.messages)).not.toContain("lavender-checkpoint");
    expect(onCandidate).toHaveBeenCalledTimes(3);
    // Provider success alone is not a transcript receipt.
    dropTranscript = true;
    await expect(
      collect(
        createTextRuntime(start, { ...scope, mode: "resume", previous: snapshot }).run(second),
      ),
    ).rejects.toThrow("No other runtime was used");
    expect(seen).toHaveLength(4);
    expect(onCandidate).toHaveBeenCalledTimes(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
