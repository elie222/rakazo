import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { sandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import { clipToolResultText } from "../../../runtime/pi/pi-runtime-limits.js";
import { CURSOR_COMPUTER_CLI_API_KEY_ENV } from "./descriptor.js";

const UNFINISHED = "The coding CLI did not finish.";
const FAILED = "The coding CLI failed.";
const UNREADABLE = "The coding CLI returned an unreadable result.";
const NOT_CONFIGURED = "The coding CLI is not configured.";
const OUTPUT_TOO_LARGE = "The coding CLI output is too large.";
/** Bound buffered output before JSON parse. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export type ComputerCodingCliCall = {
  prompt: unknown;
  model?: unknown;
  resume?: unknown;
  enabled: boolean;
  apiKey: string | undefined;
  bin: string;
  cwd: string | undefined;
  secrets: readonly string[];
};

export type ComputerCodingCliResult = { result: string; sessionId?: string } | { error: string };

/**
 * Run the vendor CLI in print mode. The API key travels only on `CommandRequest.env`.
 * Validation failures do not call `execute`.
 */
export async function executeComputerCodingCli(
  execute: (request: CommandRequest) => AsyncIterable<ProcessEvent>,
  call: ComputerCodingCliCall,
): Promise<ComputerCodingCliResult> {
  const apiKey = call.apiKey?.trim();
  if (!call.enabled || !apiKey) return { error: NOT_CONFIGURED };
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
  let captured = 0;
  try {
    for await (const event of execute({
      argv,
      cwd: call.cwd,
      env: { [CURSOR_COMPUTER_CLI_API_KEY_ENV]: apiKey },
      timeoutMs: sandboxCommandTimeoutMs(),
    })) {
      if (event.type === "stdout") {
        captured += event.data.length;
        if (captured > MAX_CAPTURE_BYTES) return { error: OUTPUT_TOO_LARGE };
        stdout += event.data;
      } else if (event.type === "stderr") {
        captured += event.data.length;
        if (captured > MAX_CAPTURE_BYTES) return { error: OUTPUT_TOO_LARGE };
        stderr += event.data;
      } else code = event.code;
    }
  } catch (error) {
    return { error: redact(error instanceof Error ? error.message : FAILED, secrets) };
  }
  return parseComputerCodingCliOutput({ stdout, stderr, code, secrets });
}

export function parseComputerCodingCliOutput(input: {
  stdout: string;
  stderr: string;
  code: number;
  secrets: readonly string[];
}): ComputerCodingCliResult {
  if (input.code === 124 || input.stderr.includes("command timed out"))
    return { error: UNFINISHED };
  const failed = (fallback: string) => ({
    error: redact(input.stderr.trim() || fallback, input.secrets),
  });
  let body: unknown;
  try {
    body = JSON.parse(input.stdout);
  } catch {
    if (input.code !== 0) return failed(FAILED);
    return failed(UNREADABLE);
  }
  if (!body || typeof body !== "object") {
    if (input.code !== 0) return failed(FAILED);
    return failed(UNREADABLE);
  }
  const record = body as {
    type?: unknown;
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
  };
  if (record.type !== "result" || record.is_error !== false) {
    const message = typeof record.result === "string" ? record.result.trim() : "";
    if (message) return { error: redact(message, input.secrets) };
    if (input.code !== 0) return failed(FAILED);
    return { error: redact(FAILED, input.secrets) };
  }
  if (typeof record.result !== "string") {
    if (input.code !== 0) return failed(FAILED);
    return failed(UNREADABLE);
  }
  if (input.code !== 0) return failed(FAILED);
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
