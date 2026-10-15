/** Real pinned engines and two synthetic accounts on one loopback provider/model. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { buildClaudeProcess, runClaudeProtocol } from "./primary-harness-claude.js";
import { buildCodexProcess, runCodexProtocol } from "./primary-harness-codex.js";
import { buildKimiProcess, runKimiProtocol } from "./primary-harness-kimi.js";
import { NativeEventQueue, NativeJsonlChannel } from "./primary-harness-protocol.js";

const modules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
const accounts = [
  { id: "synthetic-account-a", key: "fake-isolated-key-a", prompt: "Account alpha input" },
  { id: "synthetic-account-b", key: "fake-isolated-key-b", prompt: "Account beta input" },
] as const;
function reply(harness: string, res: ServerResponse, model: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Record<string, unknown>) =>
    res.write(
      `${harness === "claude" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    );
  if (harness === "claude") {
    send({
      type: "message_start",
      message: {
        id: "message-fixture",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Account verified." },
    });
    send({ type: "content_block_stop", index: 0 });
    send({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    send({ type: "message_stop" });
  } else if (harness === "codex") {
    const response = { id: "response-fixture", object: "response", created_at: 1, model };
    const item = {
      id: "message-fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Account verified." }],
    };
    send({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    send({ type: "response.output_item.done", item });
    send({
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    });
  } else {
    send({
      id: "completion-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Account verified." },
          finish_reason: "stop",
        },
      ],
    });
    send({
      id: "completion-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    res.write("data: [DONE]\n\n");
  }
  res.end();
}
async function persistedFiles(path: string): Promise<Buffer[]> {
  const files: Buffer[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await persistedFiles(child)));
    else if (entry.isFile()) files.push(await readFile(child));
  }
  return files;
}

describe.skipIf(!modules)("actual native same-provider dual-account isolation", () => {
  it.each(["claude", "codex", "kimi"] as const)(
    "%s sends the selected account key without mixing credentials or conversations",
    async (harness) => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-native-accounts-"));
      const model =
        harness === "claude"
          ? "claude-sonnet-4-5"
          : harness === "codex"
            ? "gpt-5.4"
            : "fixture-model";
      const observed: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (req.url?.includes("count_tokens")) {
          res.setHeader("content-type", "application/json");
          res.end('{"input_tokens":10}');
          return;
        }
        if (
          !req.url?.startsWith("/v1/messages") &&
          !req.url?.endsWith("/responses") &&
          !req.url?.endsWith("/chat/completions")
        ) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        observed.push({ headers: req.headers, body: JSON.parse(body) });
        reply(harness, res, model);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      try {
        const ids = await Promise.all(
          accounts.map(async (account) => {
            const home = join(root, account.id, "home"),
              sessions = join(root, account.id, "sessions");
            await mkdir(home, { recursive: true });
            await mkdir(sessions, { recursive: true });
            const request: AgentRunRequest = {
              botId: account.id,
              threadId: "shared-visible-thread",
              runId: `run-${account.id}`,
              instructions: "Answer briefly.",
              history: [],
              prompt: account.prompt,
              tools: [],
              model: {
                provider: "same-compatible-provider",
                id: model,
                apiKey: account.key,
                baseUrl: origin + (harness === "claude" ? "" : "/v1"),
                contextWindow: 128000,
              },
            };
            const launch = (
              harness === "claude"
                ? buildClaudeProcess
                : harness === "codex"
                  ? buildCodexProcess
                  : buildKimiProcess
            )(request);
            const source = launch.argv
              .at(-1)!
              .replaceAll("/opt/rakazo-harness/node_modules", modules!)
              .replaceAll("/home/harness", home)
              .replaceAll("/sessions/", `${sessions}/`);
            const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
              cwd: home,
              detached: true,
              env: {
                PATH: process.env.PATH,
                HOME: home,
                TMPDIR: home,
                ...launch.env,
                HTTP_PROXY: origin,
                HTTPS_PROXY: origin,
                ALL_PROXY: origin,
                NO_PROXY: "127.0.0.1",
              },
              stdio: ["pipe", "pipe", "pipe"],
            });
            const events = new NativeEventQueue<ProcessEvent>();
            let diagnostics = "";
            child.stdout.on("data", (data) => events.push({ type: "stdout", data: String(data) }));
            child.stderr.on("data", (data) => {
              diagnostics = (diagnostics + String(data)).slice(-2048);
            });
            child.on("exit", (code) => {
              events.push({ type: "exit", code: code ?? 1 });
              events.end();
            });
            const signal = AbortSignal.timeout(25000);
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
                  try {
                    if (child.pid) process.kill(-child.pid, "SIGKILL");
                  } catch {}
                },
              },
              signal,
              harness === "kimi",
            );
            const rpc = channel.request.bind(channel);
            channel.request = (method, params) =>
              rpc(
                method,
                method === "rakazo/start" && harness === "codex"
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
            let sessionId: string | undefined;
            const callTool = vi.fn(async () => ({ text: "Unexpected", isError: true }));
            try {
              await (harness === "claude"
                ? runClaudeProtocol
                : harness === "codex"
                  ? runCodexProtocol
                  : runKimiProtocol)(channel, {
                request,
                tools: [],
                prompt: request.prompt,
                signal,
                onSession: async (id) => {
                  sessionId = id;
                },
                setInterrupt: () => {},
                callTool,
                emit: (event) => output.push(event),
              });
              expect(
                output
                  .filter((event) => event.type === "text")
                  .map((event) => event.text)
                  .join(""),
              ).toBe("Account verified.");
              expect(callTool).not.toHaveBeenCalled();
              expect(sessionId).toBeTruthy();
            } catch (error) {
              throw new Error(`Native account probe failed: ${String(error)}; ${diagnostics}`);
            } finally {
              await channel.close();
            }
            for (const file of await persistedFiles(sessions))
              for (const identity of accounts) expect(file.includes(identity.key)).toBe(false);
            return sessionId;
          }),
        );
        expect(new Set(ids).size).toBe(2);
        expect(observed).toHaveLength(2);
        for (const account of accounts) {
          const match = observed.find((item) => JSON.stringify(item.body).includes(account.prompt));
          expect(match).toBeDefined();
          expect(match!.body.model).toBe(model);
          expect(match!.headers[harness === "claude" ? "x-api-key" : "authorization"]).toBe(
            harness === "claude" ? account.key : `Bearer ${account.key}`,
          );
          expect(
            match!.headers[harness === "claude" ? "authorization" : "x-api-key"],
          ).toBeUndefined();
          const other = accounts.find((candidate) => candidate !== account)!;
          expect(JSON.stringify(match!.headers)).not.toContain(other.key);
          expect(JSON.stringify(match!.body)).not.toContain(other.prompt);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    35000,
  );
});
