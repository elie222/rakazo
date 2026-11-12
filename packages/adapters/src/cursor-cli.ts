import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets, sandboxCommandTimeoutMs } from "@rakazo/core";
import { clipToolResultText } from "./pi-runtime-limits.js";

const UNFINISHED = "The coding CLI did not finish.";
const FAILED = "The coding CLI failed.";
const UNREADABLE = "The coding CLI returned an unreadable result.";
const NOT_CONFIGURED = "The coding CLI is not configured.";

/** `CURSOR_CLI=on` plus a key. Does not read `CLOUD_AGENT_PROVIDER`. */
export function cursorCliEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.CURSOR_CLI?.trim().toLowerCase() === "on" && Boolean(source.CURSOR_API_KEY?.trim());
}

/** One argv element. Empty means the default `agent`. */
export function cursorCliBin(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.CURSOR_CLI_BIN?.trim() || "agent";
  if (cursorCliEnabled(source) && /\s/.test(raw)) {
    throw new Error("CURSOR_CLI_BIN must not contain spaces");
  }
  return raw;
}

export type CursorCliCall = {
  prompt: unknown;
  model?: unknown;
  resume?: unknown;
  /** False when `CURSOR_CLI` is not `on`. A key alone is the HTTP cloud-agent setup. */
  enabled: boolean;
  apiKey: string | undefined;
  bin: string;
  cwd: string | undefined;
  secrets: readonly string[];
};

export type CursorCliToolResult = { result: string; sessionId?: string } | { error: string };

/**
 * Run `agent` in print mode. The key is only on `CommandRequest.env`.
 * A validation failure does not call `execute`.
 */
export async function executeCursorCli(
  execute: (request: CommandRequest) => AsyncIterable<ProcessEvent>,
  call: CursorCliCall,
): Promise<CursorCliToolResult> {
  const apiKey = call.apiKey?.trim();
  if (!call.enabled || !apiKey) return { error: NOT_CONFIGURED };
  // The child gets the trimmed key. The worker secret list may still hold the raw padded value.
  const secrets = call.secrets.includes(apiKey) ? call.secrets : [...call.secrets, apiKey];
  const prompt = text(call.prompt);
  if (!prompt) return { error: "prompt is required." };
  const model = token(call.model);
  if (model === "invalid") return { error: "model must be a single token." };
  const resume = token(call.resume);
  if (resume === "invalid") return { error: "resume must be a single token." };
  if (/\s/.test(call.bin)) return { error: "The coding CLI command name is invalid." };

  const argv = [
    call.bin,
    "-p",
    "--trust",
    "--force",
    "--output-format",
    "json",
    "--workspace",
    ".",
  ];
  if (model) argv.push("--model", model);
  if (resume) argv.push("--resume", resume);
  argv.push("--", prompt);

  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    for await (const event of execute({
      argv,
      cwd: call.cwd,
      env: { CURSOR_API_KEY: apiKey },
      timeoutMs: sandboxCommandTimeoutMs(),
    })) {
      if (event.type === "stdout") stdout += event.data;
      else if (event.type === "stderr") stderr += event.data;
      else code = event.code;
    }
  } catch (error) {
    return { error: redact(error instanceof Error ? error.message : FAILED, secrets) };
  }
  return parseCursorCliOutput({ stdout, stderr, code, secrets });
}

export function parseCursorCliOutput(input: {
  stdout: string;
  stderr: string;
  code: number;
  secrets: readonly string[];
}): CursorCliToolResult {
  if (input.code === 124 || input.stderr.includes("command timed out"))
    return { error: UNFINISHED };
  const failed = (fallback: string) => ({
    error: redact(input.stderr.trim() || fallback, input.secrets),
  });
  if (input.code !== 0) return failed(FAILED);
  let body: unknown;
  try {
    body = JSON.parse(input.stdout);
  } catch {
    return failed(UNREADABLE);
  }
  if (!body || typeof body !== "object") return failed(UNREADABLE);
  const record = body as {
    type?: unknown;
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
  };
  if (record.type !== "result" || record.is_error !== false || typeof record.result !== "string") {
    return failed(FAILED);
  }
  const session = token(record.session_id);
  const result = clipToolResultText(redactSecrets(record.result, input.secrets));
  return session && session !== "invalid" ? { result, sessionId: session } : { result };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Absent when omitted or blank. `"invalid"` when the value is not one token. */
function token(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) return "invalid";
  return trimmed;
}

function redact(value: string, secrets: readonly string[]): string {
  return clipToolResultText(redactSecrets(value, secrets).trim() || FAILED);
}
