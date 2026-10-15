/** Actual pinned engines against loopback errors only; no provider credentials or external calls. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeProcess,
  CLAUDE_SANDBOX_RUNNER,
  runClaudeProtocol,
} from "./primary-harness-claude.js";
import { CODEX_SANDBOX_RUNNER, runCodexProtocol } from "./primary-harness-codex.js";
import { NativeEventQueue, NativeJsonlChannel } from "./primary-harness-protocol.js";

const modules = process.env.RAKAZO_NATIVE_HARNESS_TEST_MODULES;
const privateMessage = "DO NOT DISPLAY upstream account detail";
describe.skipIf(!modules)("actual native provider error classification", () => {
  it.each([
    ["claude", 401],
    ["claude", 429],
    ["codex", 401],
    ["codex", 429],
  ] as const)(
    "%s HTTP %s produces a safe actionable error",
    async (harness, status) => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-native-errors-"));
      const home = join(root, "home"),
        sessions = join(root, "sessions");
      await mkdir(home);
      await mkdir(sessions);
      let modelCalls = 0;
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
        }
        if (req.url?.includes("count_tokens")) {
          res.setHeader("content-type", "application/json");
          res.end('{"input_tokens":1}');
          return;
        }
        const modelRequest = req.url?.startsWith("/v1/messages") || req.url?.endsWith("/responses");
        if (!modelRequest) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        modelCalls++;
        res.writeHead(status, { "content-type": "application/json", "retry-after": "0" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: status === 401 ? "authentication_error" : "rate_limit_error",
              code: status === 401 ? "invalid_api_key" : "rate_limit_exceeded",
              message: privateMessage,
            },
          }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      const origin = `http://127.0.0.1:${address.port}`;
      const request: AgentRunRequest = {
        runId: "error-run",
        botId: "bot",
        threadId: "thread",
        history: [],
        prompt: "Read a note.",
        instructions: "Only use the bridge.",
        tools: [],
        model: {
          id: harness === "claude" ? "claude-sonnet-4-5" : "gpt-5.4",
          provider: harness === "claude" ? "anthropic" : "openai",
          apiKey: "fake-unused-key",
          baseUrl: origin + (harness === "codex" ? "/v1" : ""),
        },
      };
      const source = (harness === "claude" ? CLAUDE_SANDBOX_RUNNER : CODEX_SANDBOX_RUNNER)
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
          ...(harness === "claude"
            ? buildClaudeProcess(request).env
            : { OPENAI_API_KEY: "fake-unused-key" }),
          HTTP_PROXY: origin,
          HTTPS_PROXY: origin,
          ALL_PROXY: origin,
          NO_PROXY: "127.0.0.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const events = new NativeEventQueue<ProcessEvent>();
      let wire = "";
      child.stdout.on("data", (data) => {
        wire = (wire + String(data)).slice(-16384);
        events.push({ type: "stdout", data: String(data) });
      });
      let diagnostic = "";
      child.stderr.on("data", (data) => {
        diagnostic += String(data);
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
      );
      const requestRpc = channel.request.bind(channel);
      channel.request = (method, params) =>
        requestRpc(
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
      const callTool = vi.fn(async () => ({ text: "unexpected", isError: false }));
      const output: AgentRuntimeEvent[] = [];
      try {
        const error = await (harness === "claude" ? runClaudeProtocol : runCodexProtocol)(channel, {
          request,
          prompt: request.prompt,
          tools: [],
          signal,
          onSession: async () => {},
          setInterrupt: () => {},
          callTool,
          emit: (event) => output.push(event),
        }).then(
          () => null,
          (error) => error,
        );
        expect(error, wire).toBeInstanceOf(Error);
        expect(String(error), wire + diagnostic).toMatch(
          status === 401 ? /could not authenticate.*Reconnect/ : /usage or rate limit.*quota/,
        );
        expect(String(error) + JSON.stringify(output)).not.toContain(privateMessage);
        expect(callTool).not.toHaveBeenCalled();
        expect(modelCalls).toBeGreaterThan(0);
      } finally {
        await channel.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
