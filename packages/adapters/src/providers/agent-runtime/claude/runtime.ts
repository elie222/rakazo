import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Options, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { deadlineSignal, withAbort } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { nativeTextRuntime } from "./descriptor.js";
import { nativeTextInstructions, nativeTextPrompt } from "./runtime.prompt.js";
import type { NativeTextSessionTurn } from "./text-session.js";
import {
  captureNativeTextSession,
  NATIVE_TEXT_PROJECT,
  nativeTextSessionScope,
  restoreNativeTextSession,
} from "./text-session.js";

const running = new Map<string, AbortController>();
const TURN_TIMEOUT_MS = 90_000;

type Spawn = NonNullable<Options["spawnClaudeCodeProcess"]>;

/** The launcher must provide the OS sandbox. There is no fallback to spawning on the host. */
function isolatedLauncher(launcher: string): Spawn {
  return (options) => {
    const { cwd, command, env } = options;
    if (!cwd || !isAbsolute(command)) throw new Error("The pinned runtime binary was not found.");
    // Rebuild after the SDK's own environment handling. Do not forward process.env.
    return spawn(launcher, [command, ...options.args], {
      cwd,
      env: {
        HOME: cwd,
        CLAUDE_CONFIG_DIR: cwd,
        ...(env.CLAUDE_CODE_PROJECT_DIR_NAME === NATIVE_TEXT_PROJECT
          ? { CLAUDE_CODE_PROJECT_DIR_NAME: NATIVE_TEXT_PROJECT }
          : {}),
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
      },
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
  };
}

export function createNativeTextRuntime(
  launcher: string,
  sessionTurn?: NativeTextSessionTurn,
): AgentRuntime {
  return createTextRuntime(isolatedLauncher(launcher), sessionTurn);
}

/** Process transport is injected so tests can use the actual SDK against an offline endpoint. */
export function createTextRuntime(start: Spawn, sessionTurn?: NativeTextSessionTurn): AgentRuntime {
  return {
    describe: () => ({
      id: nativeTextRuntime.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    }),
    async abort(runId) {
      running.get(runId)?.abort();
    },
    async *run(
      request: AgentRunRequest,
      ctx?: Partial<AdapterContext>,
    ): AsyncIterable<AgentRuntimeEvent> {
      if (!request.model.apiKey) throw new Error("The primary runtime needs its selected API key.");
      if (running.has(request.runId))
        throw new Error("The primary runtime is already executing this run.");
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        deadlineSignal(TURN_TIMEOUT_MS),
        ...(ctx?.signal ? [ctx.signal] : []),
      ]);
      const interrupt = new AbortController();
      const onAbort = () => interrupt.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      running.set(request.runId, controller);
      let scratch: string | undefined;
      try {
        signal.throwIfAborted();
        const scope = sessionTurn ? nativeTextSessionScope(sessionTurn, request) : undefined;
        const previous = sessionTurn?.mode === "resume" ? sessionTurn.previous : undefined;
        if (sessionTurn?.mode === "resume" && !previous)
          throw new Error("The requested native session is missing.");
        const nativeSessionId = scope ? (previous?.sessionId ?? randomUUID()) : undefined;
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        scratch = await mkdtemp(join(tmpdir(), "rakazo-primary-"));
        signal.throwIfAborted();
        const secrets = [...(request.secrets ?? []), request.model.apiKey];
        if (scope && previous)
          await restoreNativeTextSession(scratch, scope, previous, request.model.apiKey, secrets);
        signal.throwIfAborted();
        let exitedCleanly: Promise<boolean> | undefined;
        const spawnSession: Spawn = (options) => {
          const child = start(options);
          exitedCleanly = new Promise((resolve) => {
            child.on("exit", (code, signal) => resolve(code === 0 && signal === null));
            child.on("error", () => resolve(false));
          });
          return child;
        };
        const session = query({
          prompt: nativeTextPrompt(
            request.prompt,
            scope
              ? []
              : request.history.filter(
                  (entry) => entry.id !== request.sourceMessageId || !entry.id,
                ),
            secrets,
          ),
          options: {
            cwd: scratch,
            env: {
              HOME: scratch,
              CLAUDE_CONFIG_DIR: scratch,
              ...(scope ? { CLAUDE_CODE_PROJECT_DIR_NAME: NATIVE_TEXT_PROJECT } : {}),
              PATH: "/usr/bin:/bin",
              ANTHROPIC_API_KEY: request.model.apiKey,
              ANTHROPIC_BASE_URL: "https://api.anthropic.com",
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              DISABLE_TELEMETRY: "1",
            },
            abortController: interrupt,
            model: request.model.id,
            systemPrompt: nativeTextInstructions(request.instructions, secrets),
            tools: [],
            disallowedTools: ["*"],
            permissionMode: "dontAsk",
            strictMcpConfig: true,
            mcpServers: {},
            settingSources: [],
            persistSession: Boolean(scope),
            ...(nativeSessionId
              ? previous
                ? { resume: nativeSessionId }
                : { sessionId: nativeSessionId }
              : {}),
            includePartialMessages: true,
            maxTurns: 1,
            spawnClaudeCodeProcess: scope ? spawnSession : start,
          },
        });
        let init = false;
        let streamedText = false;
        let completed: SDKResultSuccess | undefined;
        let assistantUuid: string | undefined;
        try {
          for await (const message of session) {
            signal.throwIfAborted();
            if (message.type === "system" && message.subtype === "init") {
              if (
                message.tools.length ||
                message.mcp_servers.length ||
                message.model !== request.model.id ||
                (nativeSessionId && message.session_id !== nativeSessionId)
              )
                throw new Error("Unexpected tools in the text-only primary runtime.");
              init = true;
            }
            if (!init) continue;
            if (scope && message.type === "assistant") {
              if (message.message.content.some((block) => block.type === "tool_use"))
                throw new Error("An unexpected tool call was refused.");
              assistantUuid = message.uuid;
            }
            if (
              message.type === "stream_event" &&
              message.event.type === "content_block_start" &&
              message.event.content_block.type === "tool_use"
            ) {
              throw new Error("An unexpected tool call was refused.");
            }
            if (
              message.type === "stream_event" &&
              message.event.type === "content_block_delta" &&
              message.event.delta.type === "text_delta"
            ) {
              const text = message.event.delta.text;
              if (text) {
                streamedText = true;
                yield { type: "text", text };
              }
            }
            if (message.type !== "result") continue;
            if (
              completed ||
              message.is_error ||
              message.subtype !== "success" ||
              (nativeSessionId && message.session_id !== nativeSessionId)
            )
              throw new Error("The primary runtime could not complete this turn.");
            completed = message;
            if (!scope) break;
          }
        } finally {
          session.close();
        }
        if (!completed) throw new Error("The primary runtime stopped without a completed turn.");
        signal.throwIfAborted();
        const usage = {
          type: "usage",
          provider: request.model.provider,
          model: request.model.id,
          billing: "api_key",
          callId: request.runId,
          inputTokens: completed.usage.input_tokens,
          outputTokens: completed.usage.output_tokens,
          cacheReadTokens: completed.usage.cache_read_input_tokens,
          cacheWriteTokens: completed.usage.cache_creation_input_tokens,
          totalTokens: null,
          costUsd: null,
        } as const;
        await request.onUsage?.(usage);
        if (sessionTurn && scope && nativeSessionId) {
          if (!assistantUuid || !exitedCleanly || !(await withAbort(exitedCleanly, signal)))
            throw new Error("The native process did not flush a completed turn.");
          signal.throwIfAborted();
          const snapshot = await captureNativeTextSession(
            scratch,
            scope,
            nativeSessionId,
            assistantUuid,
            request.model.apiKey,
            secrets,
          );
          if (previous?.transcript === snapshot.transcript)
            throw new Error("Native session did not record the completed turn.");
          signal.throwIfAborted();
          sessionTurn.onCandidate(snapshot);
        }
        signal.throwIfAborted();
        yield { ...usage, accounted: Boolean(request.onUsage) };
        yield streamedText ? { type: "done" } : { type: "done", text: completed.result };
      } catch {
        if (ctx?.signal?.aborted || controller.signal.aborted) return;
        // Never expose SDK stderr, errors or provider payloads; they can carry credentials.
        throw new Error("The primary runtime failed or timed out. No other runtime was used.");
      } finally {
        interrupt.abort();
        signal.removeEventListener("abort", onAbort);
        running.delete(request.runId);
        if (scratch)
          await bestEffort(
            "remove primary runtime scratch",
            rm(scratch, { recursive: true, force: true }),
          );
      }
    },
  };
}
