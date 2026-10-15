import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ConnectorTool,
  ProcessEvent,
  SandboxProcessHandle,
} from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { buildKimiProcess, runKimiProtocol } from "./primary-harness-kimi.js";
import {
  NativeEventQueue,
  NativeHarnessPaused,
  NativeJsonlChannel,
} from "./primary-harness-protocol.js";

// Opt in with Node >=22.19 and official npm packages @moonshot-ai/kimi-code@2.2.0
// and @modelcontextprotocol/sdk@1.30.0 preinstalled in one node_modules directory:
// RAKAZO_NATIVE_HARNESS_TEST_MODULES=/path/to/node_modules pnpm exec vitest run \
//   packages/adapters/src/primary-harness-kimi-offline-integration.test.ts
// This test starts only the pinned local CLI and a loopback HTTP fixture. It never
// installs packages, uses real credentials, or sends requests to a public provider.
const modules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
const FAKE_KEY = "fake-kimi-offline-test-key";
const INSTRUCTIONS = "Use the provided tools. $" + "{literal} {% literal %}";
const tool: ConnectorTool = {
  name: "read_file",
  description: "Read the deterministic fixture file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

interface CompletionRequest {
  model: string;
  stream: boolean;
  tools: Array<{ type: string; function: { name: string } }>;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
}

function completionStream(index: number): string {
  const delta =
    index === 1 || index === 3
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_read_fixture",
              type: "function",
              function: { name: "mcp__rakazo__read_file", arguments: '{"path":"note.txt"}' },
            },
          ],
        }
      : { role: "assistant", content: index === 2 ? "Read complete." : "Resumed complete." };
  const chunk = (choices: unknown[], usage?: Record<string, unknown>) => ({
    id: `completion-fixture-${index}`,
    object: "chat.completion.chunk",
    created: 123,
    model: "fixture-model",
    choices,
    ...(usage ? { usage } : {}),
  });
  const frames = [
    chunk([{ index: 0, delta, finish_reason: null }]),
    chunk([
      { index: 0, delta: {}, finish_reason: index === 1 || index === 3 ? "tool_calls" : "stop" },
    ]),
    chunk([], {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 2 },
    }),
  ];
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Test-only local transport: production still requires the isolated sandbox. */
function localProcess(request: AgentRunRequest, home: string, sessions: string) {
  const start = buildKimiProcess(request);
  const events = new NativeEventQueue<ProcessEvent>();
  let stdout = "";
  let stdin = "";
  let stderr = "";
  // Exercise the production bootstrap itself, rebasing only its two sandbox mounts.
  const argv = start.argv.slice(1).map((arg) =>
    arg
      .replaceAll("'/home/harness'", JSON.stringify(home))
      .replaceAll("/opt/rakazo-harness/node_modules", modules!)
      .replace(
        "child.stderr.on('data',()=>{});",
        "child.stderr.on('data',d=>process.stderr.write(d));",
      )
      .replaceAll(
        "'/sessions/kimi-code-sessions'",
        JSON.stringify(join(sessions, "kimi-code-sessions")),
      ),
  );
  const child = spawn(process.execPath, argv, {
    cwd: home,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      LANG: "C.UTF-8",
      KIMI_DISABLE_TELEMETRY: "1",
      ...start.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    stdout += data;
    events.push({ type: "stdout", data });
  });
  child.stderr.on("data", (data: string) => {
    stderr = (stderr + data).slice(-65_536);
  });
  child.on("error", (error) => events.end(error));
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      events.push({ type: "exit", code: code ?? 1 });
      events.end();
      resolve();
    });
  });
  function kill(signal: NodeJS.Signals) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const handle: SandboxProcessHandle = {
    events,
    writeStdin: (data) =>
      new Promise<void>((resolve, reject) => {
        stdin += data;
        child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
      }),
    closeStdin: async () => {
      child.stdin.end();
    },
    terminate: async () => {
      kill("SIGTERM");
      const force = setTimeout(() => kill("SIGKILL"), 1_000);
      force.unref();
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    },
  };
  return { handle, stdout: () => stdout, stderr: () => stderr, stdin: () => stdin };
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

describe.skipIf(!modules)("pinned Kimi native offline integration", () => {
  it("bridges declared tools and original images, verifies usage and terminals, and resumes privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-kimi-offline-"));
    const home = join(root, "home");
    const sessions = join(root, "sessions");
    await mkdir(home);
    await mkdir(sessions);
    const picture = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const pixels = Buffer.alloc(640 * 640 * 3);
    let seed = 123;
    for (let index = 0; index < pixels.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[index] = seed >>> 24;
    }
    const screenshot = await sharp(pixels, { raw: { width: 640, height: 640, channels: 3 } })
      .png()
      .toBuffer();
    const largePixels = Buffer.alloc(1536 * 1366 * 3);
    for (let index = 0; index < largePixels.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      largePixels[index] = seed >>> 24;
    }
    const largePicture = await sharp(largePixels, {
      raw: { width: 1536, height: 1366, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(largePicture.byteLength).toBeGreaterThan(6 * 1024 * 1024);
    expect(screenshot.byteLength).toBeGreaterThan(1024 * 1024);
    const requests: CompletionRequest[] = [];
    const failures: unknown[] = [];
    const server = createServer((incoming, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionRequest;
        requests.push(body);
        expect(incoming.url).toBe("/v1/chat/completions");
        expect(incoming.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
        expect(body.model).toBe("fixture-model");
        expect(body.stream).toBe(true);
        expect(JSON.stringify(body.messages)).toContain(
          `data:image/png;base64,${picture.toString("base64")}`,
        );
        if (requests.length === 1) {
          // The official ACP server optimizes oversized images and adds a caption.
          // Original bytes enter ACP; do not claim byte-identical provider output.
          expect(JSON.stringify(body.messages)).toContain("Image compressed to fit model limits");
          const imageParts = body.messages
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            .filter((part) => part.type === "image_url");
          expect(imageParts).toHaveLength(2);
          expect(imageParts.every((part) => part.image_url.url.startsWith("data:image/"))).toBe(
            true,
          );
          const optimized = Buffer.from(imageParts[1]!.image_url.url.split(",")[1], "base64");
          const metadata = await sharp(optimized).metadata();
          expect(metadata.width).toBeGreaterThan(100);
          expect(metadata.height).toBeGreaterThan(100);
          expect(
            (await sharp(optimized).stats()).channels.some((channel) => channel.stdev > 10),
          ).toBe(true);
          expect(JSON.stringify(body.messages)).toContain("current-picture.png");
          expect(JSON.stringify(body.messages)).toContain("peer-picture.png");
        }
        expect(body.tools.map((entry) => entry.function.name)).toEqual(["mcp__rakazo__read_file"]);
        expect(JSON.stringify(body.messages[0])).toContain("Use the provided tools");
        if (requests.length === 2 || requests.length === 4) {
          expect(body.messages.filter((message) => message.role === "tool")).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ tool_call_id: "call_read_fixture" }),
            ]),
          );
          expect(JSON.stringify(body.messages)).toContain(
            `data:image/png;base64,${screenshot.toString("base64")}`,
          );
          expect(JSON.stringify(body.messages)).toContain("fixture contents");
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(completionStream(requests.length));
      })().catch((error: unknown) => {
        failures.push(error);
        response.writeHead(500);
        response.end("Offline fixture assertion failed");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>, callId: string) => {
      expect(name).toBe("read_file");
      expect(args).toEqual({ path: "note.txt" });
      expect(callId).toMatch(/^session_[a-zA-Z0-9_-]+:tool:/);
      return {
        text: "fixture contents",
        isError: false,
        content: [
          { type: "text" as const, text: "fixture contents" },
          {
            type: "image" as const,
            mimeType: "image/png" as const,
            data: screenshot.toString("base64"),
          },
        ],
      };
    });
    let nativeSessionId: string | undefined;
    const runTurn = async (resume: boolean) => {
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: resume ? "fixture-resume" : "fixture-first",
        instructions: INSTRUCTIONS,
        prompt: resume ? "Continue the conversation." : "Read note.txt using read_file.",
        history: resume
          ? []
          : [
              {
                id: "peer-message",
                role: "assistant",
                content: "Peer image",
                images: [{ name: "peer-picture.png", mimeType: "image/png", data: picture }],
              },
            ],
        currentTurnImages: resume
          ? []
          : [{ name: "current-picture.png", mimeType: "image/png", data: largePicture }],
        tools: [tool],
        model: {
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: FAKE_KEY,
          baseUrl: endpoint,
          contextWindow: 128_000,
          acceptsImages: true,
        },
      };
      const process = localProcess(request, home, sessions);
      const signal = AbortSignal.timeout(25_000);
      const channel = new NativeJsonlChannel(process.handle, signal, true);
      const events: AgentRuntimeEvent[] = [];
      const previousSession = nativeSessionId;
      try {
        await runKimiProtocol(channel, {
          request,
          tools: [tool],
          prompt: request.prompt,
          nativeSessionId: resume ? nativeSessionId : undefined,
          onSession: async (id) => {
            if (resume) expect(id).toBe(previousSession);
            nativeSessionId = id;
          },
          signal,
          emit: (event) => events.push(event),
          callTool,
          setInterrupt: () => undefined,
        });
      } catch (error) {
        throw new Error(
          `Pinned Kimi offline round failed. ${process.stderr()}\n${process.stdout()}`,
          { cause: error },
        );
      } finally {
        await channel.close();
      }
      expect(failures.map((error) => String(error))).toEqual([]);
      if (!resume) expect(process.stdin().includes(largePicture.toString("base64"))).toBe(true);
      const frames = process
        .stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(frames).toContainEqual({
        jsonrpc: "2.0",
        id: "rakazo:kimi:prompt",
        result: { stopReason: "end_turn", verifiedReason: "completed" },
      });
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => event.text)
          .join(""),
      ).toBe(resume ? "Resumed complete." : "Read complete.");
      const usage = events.filter((event) => event.type === "usage");
      expect(usage).toHaveLength(2);
      for (const event of usage) {
        expect(event).toMatchObject({
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          totalTokens: 17,
          usageSource: "kimi-code-wire",
        });
      }
    };
    try {
      await runTurn(false);
      expect(nativeSessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      // A new process receives a disposable HOME, while the private session mount survives.
      await rm(home, { recursive: true, force: true });
      await mkdir(home);
      await runTurn(true);
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[2]?.messages)).toContain("Read complete.");
      expect(JSON.stringify(requests[2]?.messages)).toContain("fixture contents");
      expect(failures).toEqual([]);
      const persisted = await filesUnder(sessions);
      expect(persisted.some((file) => file.endsWith("wire.jsonl"))).toBe(true);
      for (const file of persisted) {
        expect(await readFile(file, "utf8")).not.toContain(FAKE_KEY);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
  it.each([
    "provider-failure",
    "authentication",
    "quota",
    "disabled-tool",
    "missing-usage",
    "media-stripped",
  ] as const)(
    "handles actual native %s without unexpected host effects",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-kimi-negative-"));
      const home = join(root, "home"),
        sessions = join(root, "sessions");
      await mkdir(home);
      await mkdir(sessions);
      let calls = 0;
      const server = createServer((incoming, response) => {
        incoming.resume();
        calls++;
        if (
          ["provider-failure", "authentication", "quota"].includes(scenario) ||
          (scenario === "media-stripped" && calls === 1)
        ) {
          response.writeHead(
            scenario === "authentication" ? 401 : scenario === "quota" ? 429 : 400,
            { "Content-Type": "application/json", "retry-after": "0" },
          );
          response.end(
            JSON.stringify({
              error: {
                message:
                  scenario === "media-stripped"
                    ? "Invalid image format"
                    : "deterministic provider failure",
                type:
                  scenario === "authentication"
                    ? "authentication_error"
                    : scenario === "quota"
                      ? "rate_limit_error"
                      : "invalid_request_error",
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        if (scenario === "missing-usage") {
          response.end(
            completionStream(2)
              .split("\n\n")
              .filter((frame) => !frame.includes('"usage":'))
              .join("\n\n"),
          );
          return;
        }
        if (scenario === "media-stripped") {
          response.end(completionStream(1));
          return;
        }
        const chunk = {
          id: "forged",
          object: "chat.completion.chunk",
          created: 123,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "native-shell",
                    type: "function",
                    function: {
                      name: "Shell",
                      arguments: JSON.stringify({
                        command: `touch ${join(home, "escape-marker")}`,
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        response.end(
          "data: " +
            JSON.stringify(chunk) +
            "\n\ndata: " +
            JSON.stringify({
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: scenario,
        instructions: "Use mediated tools",
        prompt: "Perform the test",
        history: [],
        tools: [tool],
        model: {
          provider: "openai-compatible",
          id: "fixture-model",
          apiKey: FAKE_KEY,
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          contextWindow: 128000,
        },
      };
      if (scenario === "media-stripped") {
        request.model.acceptsImages = true;
        request.currentTurnImages = [
          {
            name: "original.png",
            mimeType: "image/png",
            data: await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
              .png()
              .toBuffer(),
          },
        ];
      }
      const process = localProcess(request, home, sessions);
      const signal = AbortSignal.timeout(25000),
        channel = new NativeJsonlChannel(process.handle, signal, true);
      const callTool = vi.fn(async () => ({ text: "should not execute", isError: false }));
      const observed: AgentRuntimeEvent[] = [];
      try {
        const running = runKimiProtocol(channel, {
          request,
          tools: [tool],
          prompt: request.prompt,
          onSession: () => undefined,
          signal,
          callTool,
          emit: (event) => observed.push(event),
          setInterrupt: () => undefined,
        });
        if (scenario === "missing-usage") {
          await running;
          expect(observed.filter((event) => event.type === "usage")).toEqual([
            expect.objectContaining({
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              usageSource: "kimi-code-usage-unavailable",
            }),
          ]);
        } else
          await expect(running).rejects.toThrow(
            scenario === "authentication"
              ? /could not authenticate.*Reconnect/
              : scenario === "quota"
                ? /usage or rate limit.*quota/
                : scenario === "provider-failure"
                  ? /complete successfully/
                  : scenario === "disabled-tool"
                    ? /disabled native tool/
                    : /Kimi attempted to remove attached media after a provider error; the run was stopped/,
          );
        expect(callTool).not.toHaveBeenCalled();
        expect(calls).toBeGreaterThan(0);
        await expect(access(join(home, "escape-marker"))).rejects.toThrow();
        if (scenario === "provider-failure")
          expect(process.stdout()).toContain('"verifiedReason":"failed"');
      } finally {
        await channel.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
  it("durably acknowledges effect A before pausing effect B, then resumes only B", async () => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-kimi-paused-"));
    const home = join(root, "home"),
      sessions = join(root, "sessions");
    await mkdir(home);
    await mkdir(sessions);
    let calls = 0,
      effects = 0,
      firstEffects = 0,
      nativeSessionId: string | undefined;
    const server = createServer((incoming, response) => {
      incoming.resume();
      calls++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      let stream = completionStream(calls < 3 ? 1 : 2);
      if (calls === 1)
        stream = stream
          .split("\n\n")
          .map((frame) => {
            if (!frame.startsWith("data: {") || !frame.includes('"tool_calls":[')) return frame;
            const item = JSON.parse(frame.slice(6));
            item.choices[0].delta.tool_calls.unshift({
              index: 0,
              id: "call_first_effect",
              type: "function",
              function: { name: "mcp__rakazo__read_file", arguments: '{"path":"first.txt"}' },
            });
            item.choices[0].delta.tool_calls[1].index = 1;
            return `data: ${JSON.stringify(item)}`;
          })
          .join("\n\n");
      response.end(stream);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const events: AgentRuntimeEvent[] = [];
    async function turn(resume: boolean) {
      const request: AgentRunRequest = {
        botId: "fixture-bot",
        threadId: "fixture-thread",
        runId: "same-paused-run",
        instructions: INSTRUCTIONS,
        prompt: resume
          ? "The pending operation is approved; use read_file again."
          : "Use read_file.",
        history: [],
        tools: [tool],
        model: {
          provider: "custom",
          id: "fixture-model",
          apiKey: FAKE_KEY,
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          contextWindow: 128000,
        },
      };
      const process = localProcess(request, home, sessions),
        signal = AbortSignal.timeout(25000),
        channel = new NativeJsonlChannel(process.handle, signal, true);
      const running = runKimiProtocol(channel, {
        request,
        tools: [tool],
        prompt: request.prompt,
        nativeSessionId: resume ? nativeSessionId : undefined,
        onSession: (id) => {
          nativeSessionId = id;
        },
        signal,
        emit: (event) => events.push(event),
        setInterrupt: () => undefined,
        callTool: async (_name, args) => {
          expect(nativeSessionId).toBeDefined();
          if (args.path === "first.txt") {
            firstEffects++;
            return { text: "first effect committed", isError: false };
          }
          if (!resume) {
            const files = await filesUnder(sessions);
            const wireFile = files.find((file) => file.endsWith("wire.jsonl"))!;
            const records = (await readFile(wireFile, "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(
              records.some(
                (record) =>
                  record.type === "context.append_loop_event" &&
                  record.event?.type === "tool.result" &&
                  record.event.toolCallId === "call_first_effect",
              ),
            ).toBe(true);
            throw new NativeHarnessPaused();
          }
          effects++;
          return { text: "approved fixture contents", isError: false };
        },
      });
      try {
        if (resume) await running;
        else await expect(running).rejects.toBeInstanceOf(NativeHarnessPaused);
      } finally {
        await channel.close();
      }
    }
    try {
      await turn(false);
      expect(effects).toBe(0);
      expect(firstEffects).toBe(1);
      expect(nativeSessionId).toBeDefined();
      expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
      await rm(home, { recursive: true, force: true });
      await mkdir(home);
      await turn(true);
      expect(effects).toBe(1);
      expect(firstEffects).toBe(1);
      expect(calls).toBe(3);
      const usage = events.filter((event) => event.type === "usage");
      expect(usage).toHaveLength(3);
      expect(new Set(usage.map((event) => event.callId)).size).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
