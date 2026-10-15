/**
 * Opt-in real pinned engines, local fake provider only. No credentials or production requests.
 * Install the exact image npm dependencies into a disposable directory, then run with:
 * RAKAZO_NATIVE_HARNESS_TEST_MODULES=/absolute/path/node_modules vitest run <this file>
 * This checks SDK/app-server compatibility, not Docker isolation or live provider compatibility.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@rakazo/adapter-kit";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildClaudeProcess,
  CLAUDE_SANDBOX_RUNNER,
  runClaudeProtocol,
} from "./primary-harness-claude.js";
import { CODEX_SANDBOX_RUNNER, runCodexProtocol } from "./primary-harness-codex.js";
import {
  NativeEventQueue,
  NativeHarnessPaused,
  NativeJsonlChannel,
} from "./primary-harness-protocol.js";

const modules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
const fakeKey = "fake-offline-integration-key";
const tool = {
  name: "read_file",
  description: "Read a file through the authorized computer bridge.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function anthropic(res: ServerResponse, count: number, pauseBatch = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, body: Record<string, unknown>) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_${count}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 30,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  if (count % 2) {
    send("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: `tool_${count}`,
        name: "mcp__rakazo__read_file",
        input: {},
      },
    });
    send("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"note.md"}' },
    });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Offline native round verified." },
    });
  }
  send("content_block_stop", { index: 0 });
  if (pauseBatch && count === 1) {
    send("content_block_start", {
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tool_pause",
        name: "mcp__rakazo__read_file",
        input: {},
      },
    });
    send("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"approval.md"}' },
    });
    send("content_block_stop", { index: 1 });
  }
  send("message_delta", {
    delta: { stop_reason: count % 2 ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 12 },
  });
  send("message_stop", {});
  res.end();
}
function responses(res: ServerResponse, count: number, pauseBatch = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (body: Record<string, unknown>) => res.write(`data: ${JSON.stringify(body)}\n\n`);
  const response = { id: `resp_${count}`, object: "response", created_at: 1, model: "gpt-5.4" };
  send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  const item =
    count % 2
      ? {
          id: `item_${count}`,
          type: "function_call",
          call_id: `call_${count}`,
          namespace: "rakazo",
          name: "read_file",
          arguments: '{"path":"note.md"}',
        }
      : {
          id: `item_${count}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Offline native round verified." }],
        };
  const items = [item];
  if (pauseBatch && count === 1)
    items.push({
      id: "item_pause",
      type: "function_call",
      call_id: "call_pause",
      namespace: "rakazo",
      name: "read_file",
      arguments: '{"path":"approval.md"}',
    });
  for (const item of items) send({ type: "response.output_item.done", item });
  send({
    type: "response.completed",
    response: {
      ...response,
      status: "completed",
      output: items,
      usage: {
        input_tokens: 30,
        output_tokens: 12,
        total_tokens: 42,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}
async function contents(directory: string): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...(await contents(join(directory, entry.name))));
    else if (entry.isFile()) result.push(await readFile(join(directory, entry.name)));
  }
  return result;
}

// Explicit opt-in avoids installing or invoking vendor binaries during ordinary unit tests.
describe.skipIf(!modules)("actual pinned native engines against local fake APIs", () => {
  it.each([
    { harness: "claude", media: "text" },
    { harness: "claude", media: "zai-haiku" },
    { harness: "claude", media: "zai-sonnet" },
    { harness: "claude", media: "zai-opus" },
    { harness: "claude", media: "kimi-haiku" },
    { harness: "claude", media: "kimi-sonnet" },
    { harness: "claude", media: "kimi-opus" },
    { harness: "claude", media: "kimi-fable" },
    { harness: "codex", media: "text" },
    { harness: "claude", media: "image" },
    { harness: "codex", media: "image" },
    { harness: "codex", media: "audio" },
    { harness: "claude", media: "image-large" },
    { harness: "codex", media: "image-large" },
    { harness: "claude", media: "approval-pause" },
    { harness: "codex", media: "approval-pause" },
  ] as const)(
    "$harness $media bridges tools, resumes with fresh HOME, and never persists credentials",
    async ({ harness, media }) => {
      const noise = Buffer.alloc(1024 * 1024 * 3);
      let random = 12345;
      for (let i = 0; i < noise.length; i++) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        noise[i] = random & 255;
      }
      const imageBytes =
        media === "image-large"
          ? await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } })
              .png()
              .toBuffer()
          : await sharp({
              create: { width: 2, height: 2, channels: 3, background: "white" },
            })
              .png()
              .toBuffer();
      const audioBytes = Buffer.alloc(76);
      audioBytes.write("RIFF");
      audioBytes.writeUInt32LE(68, 4);
      audioBytes.write("WAVEfmt ", 8);
      audioBytes.writeUInt32LE(16, 16);
      audioBytes.writeUInt16LE(1, 20);
      audioBytes.writeUInt16LE(1, 22);
      audioBytes.writeUInt32LE(16000, 24);
      audioBytes.writeUInt32LE(32000, 28);
      audioBytes.writeUInt16LE(2, 32);
      audioBytes.writeUInt16LE(16, 34);
      audioBytes.write("data", 36);
      audioBytes.writeUInt32LE(32, 40);
      const root = await mkdtemp(join(tmpdir(), `rakazo-native-${harness}-`));
      const home = join(root, "home");
      const sessions = join(root, "sessions");
      await mkdir(sessions);
      const compatible = media.startsWith("zai-") || media.startsWith("kimi-");
      const authScheme = media.startsWith("zai-") ? ("bearer" as const) : ("api-key" as const);
      const configuredModel = media.startsWith("zai-") ? "glm-5.3" : "k3-256k";
      const role = media.split("-")[1] ?? "sonnet";
      let count = 0;
      const headers: IncomingMessage["headers"][] = [];
      const bodies: Record<string, unknown>[] = [];
      const server = createServer(async (req: IncomingMessage, res) => {
        let raw = "";
        for await (const data of req) raw += data;
        if (req.url?.includes("count_tokens")) {
          res.setHeader("content-type", "application/json");
          res.end('{"input_tokens":30}');
          return;
        }
        if (!req.url?.startsWith("/v1/messages") && !req.url?.endsWith("/responses")) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        bodies.push(JSON.parse(raw));
        headers.push(req.headers);
        count++;
        if (harness === "claude") anthropic(res, count, media === "approval-pause");
        else responses(res, count, media === "approval-pause");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local test address");
      const endpoint = `http://127.0.0.1:${address.port}${harness === "codex" ? "/v1" : ""}`;
      let nativeSessionId: string | undefined;
      let usageState: Record<string, unknown> | undefined;
      let completedEffects = 0;
      let nativeResultWrittenBeforePause = false;
      try {
        for (let turn = 0; turn < 2; turn++) {
          const request: AgentRunRequest = {
            runId: `run-${media === "approval-pause" ? 0 : turn}`,
            botId: "bot",
            threadId: "thread",
            prompt: `Read note.md; turn ${turn}`,
            history: media.startsWith("image")
              ? [
                  {
                    id: "history-media",
                    role: "user",
                    content: "Earlier image.",
                    images: [{ name: "earlier.png", mimeType: "image/png", data: imageBytes }],
                  },
                ]
              : [],
            ...(media.startsWith("image")
              ? {
                  currentTurnImages: [
                    { name: "current.png", mimeType: "image/png" as const, data: imageBytes },
                  ],
                }
              : {}),
            ...(media === "audio"
              ? {
                  currentTurnAudio: [
                    { name: "original.wav", mimeType: "audio/wav" as const, data: audioBytes },
                  ],
                }
              : {}),
            instructions: "Use only the authorized read_file tool, then summarize.",
            tools: [tool],
            model: {
              id:
                harness === "claude"
                  ? compatible
                    ? role
                    : "claude-sonnet-4-5"
                  : media === "audio"
                    ? "configured-audio-model"
                    : "gpt-5.4",
              acceptsImages: media.startsWith("image"),
              acceptsAudio: media === "audio",
              provider: harness === "claude" ? "anthropic" : "openai",
              apiKey: fakeKey,
              ...(compatible
                ? {
                    authScheme,
                    modelRoles: {
                      haiku: configuredModel,
                      sonnet: configuredModel,
                      opus: configuredModel,
                      fable: configuredModel,
                      subagent: configuredModel,
                    },
                  }
                : {}),
              baseUrl: endpoint,
            },
          };
          await mkdir(home, { recursive: true, mode: 0o700 });
          await mkdir(join(root, "tmp"), { recursive: true, mode: 0o700 });
          const source = (harness === "claude" ? CLAUDE_SANDBOX_RUNNER : CODEX_SANDBOX_RUNNER)
            .replaceAll("/opt/rakazo-harness/node_modules", modules!)
            .replaceAll("/home/harness", home)
            .replaceAll("/sessions/", `${sessions}/`);
          const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
            cwd: home,
            detached: true,
            env: {
              PATH: process.env.PATH,
              TMPDIR: join(root, "tmp"),
              HOME: home,
              ...(harness === "claude"
                ? buildClaudeProcess(request).env
                : { OPENAI_API_KEY: fakeKey }),
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const events = new NativeEventQueue<ProcessEvent>();
          let diagnostic = "";
          let wire = "";
          let diagnosticFrame = "";
          const frameSizes: string[] = [];
          child.stdout.setEncoding("utf8").on("data", (data: string) => {
            wire = (wire + data).slice(-500);
            diagnosticFrame += data;
            while (true) {
              const newline = diagnosticFrame.indexOf("\n");
              if (newline < 0) break;
              const line = diagnosticFrame.slice(0, newline);
              diagnosticFrame = diagnosticFrame.slice(newline + 1);
              if (line.length > 100000) {
                const value = JSON.parse(line);
                frameSizes.push(`${value.method}:${value.params?.item?.type}:${line.length}`);
              }
            }
            events.push({ type: "stdout", data });
          });
          child.stderr.setEncoding("utf8").on("data", (data: string) => {
            diagnostic = (diagnostic + data).slice(-8192);
          });
          child.on("error", (error) => events.end(error));
          child.on("exit", (code) => {
            events.push({ type: "exit", code: code ?? 1 });
            events.end();
          });
          const signal = AbortSignal.timeout(60_000);
          const channel = new NativeJsonlChannel(
            {
              events,
              writeStdin: async (data) => {
                child.stdin.write(data);
              },
              closeStdin: async () => {
                child.stdin.end();
              },
              terminate: async () => {
                events.end();
                if (child.pid) {
                  try {
                    process.kill(-child.pid, "SIGKILL");
                  } catch {
                    /* already exited */
                  }
                }
              },
            },
            signal,
          );
          const originalRequest = channel.request.bind(channel);
          channel.request = (method, params) =>
            originalRequest(
              method,
              params.config
                ? {
                    ...params,
                    config: {
                      ...(params.config as Record<string, unknown>),
                      sqlite_home: join(sessions, "codex-state"),
                    },
                  }
                : params,
            );
          const output: AgentRuntimeEvent[] = [];
          const calls: string[] = [];
          const priorSession = nativeSessionId;
          try {
            await (harness === "claude" ? runClaudeProtocol : runCodexProtocol)(channel, {
              request,
              tools: [tool],
              prompt: request.prompt,
              nativeSessionId,
              usageState,
              signal,
              emit: (event) => output.push(event),
              setInterrupt: () => undefined,
              onSession: (id) => {
                nativeSessionId = id;
              },
              onUsageState: (state) => {
                usageState = state;
              },
              callTool: async (name, args) => {
                expect(name).toBe("read_file");
                if (media === "approval-pause" && args.path === "approval.md") {
                  if (turn === 0) {
                    nativeResultWrittenBeforePause = (await contents(sessions)).some((file) =>
                      file.includes("The note is blue."),
                    );
                    throw new NativeHarnessPaused();
                  }
                  return { text: "Approved second action.", isError: false };
                }
                expect(args).toEqual({ path: "note.md" });
                completedEffects++;
                calls.push(name);
                return {
                  text: "The note is blue.",
                  isError: false,
                  ...(media.startsWith("image")
                    ? {
                        content: [
                          { type: "text" as const, text: "Authorized image result." },
                          {
                            type: "image" as const,
                            mimeType: "image/png" as const,
                            data: imageBytes.toString("base64"),
                          },
                        ],
                      }
                    : {}),
                };
              },
            });
            expect(calls).toEqual(media === "approval-pause" ? [] : ["read_file"]);
            expect(
              output
                .filter((event) => event.type === "text")
                .map((event) => event.text)
                .join(""),
            ).toBe("Offline native round verified.");
            expect(nativeSessionId).toBeTruthy();
            if (turn) expect(nativeSessionId).toBe(priorSession);
            const usage = output.filter((event) => event.type === "usage");
            if (media !== "approval-pause") {
              expect(usage.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0)).toBe(60);
              expect(usage.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0)).toBe(24);
            } else expect(usage).not.toHaveLength(0);
          } catch (error) {
            if (media === "approval-pause" && turn === 0 && error instanceof NativeHarnessPaused) {
              expect(nativeSessionId).toBeTruthy();
              if (turn) expect(nativeSessionId).toBe(priorSession);
              expect(completedEffects).toBe(1);
            } else
              throw new Error(
                `Pinned ${harness} integration failed at turn ${turn}: ${String(error)}; events: ${JSON.stringify(output)}; subprocess: ${diagnostic}; frames: ${frameSizes.join(",")}; partial: ${diagnosticFrame.slice(0, 300)}; wire: ${wire}`,
              );
          } finally {
            await channel.close();
          }
          await rm(home, { recursive: true, force: true });
        }
        expect(count).toBe(media === "approval-pause" ? 2 : 4);
        if (media === "approval-pause") {
          expect(completedEffects).toBe(1);
          // Observation only: persistence is not an exactly-once guarantee. The
          // executor's separate effect-ledger tests cover safe rejection of reissues.
          const resumedResultPresent = JSON.stringify(bodies[1]).includes("The note is blue.");
          process.stdout.write(
            `${harness} parallel pause: prior result journaled=${nativeResultWrittenBeforePause}, present on resume=${resumedResultPresent}\n`,
          );
        }
        if (media.startsWith("image")) {
          for (const body of bodies) {
            const serialized = JSON.stringify(body);
            if (media !== "image-large" || harness !== "claude")
              expect(serialized.includes(imageBytes.toString("base64"))).toBe(true);
            expect(serialized).toContain(
              harness === "claude" ? '"type":"image"' : '"type":"input_image"',
            );
          }
          for (const body of [bodies[1], bodies[3]])
            expect(JSON.stringify(body)).toContain("Authorized image result.");
        }
        if (media === "audio") {
          for (const body of bodies) {
            expect(JSON.stringify(body)).toContain(audioBytes.toString("base64"));
            expect(JSON.stringify(body)).toContain('"type":"input_audio"');
            expect(body.model).toBe("configured-audio-model");
          }
        }
        if (compatible) {
          for (const header of headers) {
            expect(header[authScheme === "bearer" ? "authorization" : "x-api-key"]).toBe(
              authScheme === "bearer" ? `Bearer ${fakeKey}` : fakeKey,
            );
            expect(header[authScheme === "bearer" ? "x-api-key" : "authorization"]).toBeUndefined();
          }
          for (const body of bodies) expect(body.model).toBe(configuredModel);
        }
        for (const body of bodies) {
          if (harness === "claude")
            expect((body.tools as { name: string }[]).map((item) => item.name)).toEqual([
              "mcp__rakazo__read_file",
            ]);
          else
            expect(body.tools).toEqual([
              {
                type: "namespace",
                name: "rakazo",
                description: expect.any(String),
                tools: [
                  {
                    type: "function",
                    name: "read_file",
                    description: tool.description,
                    parameters: tool.inputSchema,
                    strict: false,
                  },
                ],
              },
            ]);
        }
        const persisted = await contents(sessions);
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.some((buffer) => buffer.includes(fakeKey))).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
