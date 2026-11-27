import {
  isTransientModelError,
  ModelAccountError,
  ModelOutputError,
  TransientModelError,
} from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  MODEL_OUTPUT_LIMIT_ERROR,
  normalizeRunError,
  parseModelFallbackFailure,
  redactJsonStringsAndPlainText,
  redactPlainBearerTokens,
} from "@rakazo/core";
import {
  redactComposioApiKeyAssignments,
  redactCredentialJsonFields,
} from "../../runs/turn/secret-assignment-text.js";
import { LOCAL_PROVIDER_ID } from "./models/pi-local-provider-id.js";
import { terminalOAuthRefreshErrorMarker } from "./models/pi-oauth.js";
import { isOpenCodeProvider } from "./stream/pi-runtime-stream.js";

export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

export function messageHasToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("content" in message)) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => !!part && typeof part === "object" && "type" in part && part.type === "toolCall",
  );
}

/** Provider failure. Aborts stay on the existing cancel path. */
export function providerFailureText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (!("role" in message) || message.role !== "assistant") return undefined;
  const stopReason =
    "stopReason" in message && typeof message.stopReason === "string"
      ? message.stopReason
      : undefined;
  if (stopReason === "aborted") return undefined;
  const errorMessage =
    "errorMessage" in message &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  const text = assistantText(message).trim();
  if (stopReason === "error") {
    if (errorMessage) return errorMessage;
    if (text) return "The model failed after writing a response.";
    return "The model failed before writing a response.";
  }
  if (stopReason === "length" && !text) {
    return errorMessage || MODEL_OUTPUT_LIMIT_ERROR;
  }
  if (errorMessage && !text) return errorMessage;
  return undefined;
}

function redactJwts(text: string): string {
  if (!text.includes("eyJ")) return text;
  // Scan each base64url+dot run once so repeated "eyJ" prefixes stay linear.
  return text.replace(/[a-zA-Z0-9_.-]+/g, (run) => {
    if (!run.includes("eyJ") || !run.includes(".")) return run;
    const parts = run.split(".");
    const out: string[] = [];
    let changed = false;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const jwtAt = part.indexOf("eyJ");
      if (
        jwtAt !== -1 &&
        part.length > jwtAt + 3 &&
        index + 2 < parts.length &&
        parts[index + 1]!.length > 0 &&
        parts[index + 2]!.length > 0
      ) {
        out.push(`${part.slice(0, jwtAt)}[redacted]`);
        changed = true;
        index += 2;
      } else {
        out.push(part);
      }
    }
    return changed ? out.join(".") : run;
  });
}

export function sanitizeSensitiveText(message: string, options?: { decoded?: boolean }) {
  const bearerMasked = redactPlainBearerTokens(message, options);
  const composioMasked = redactComposioApiKeyAssignments(bearerMasked);
  const assignmentsMasked = composioMasked
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(
      /COMPOSIO_API_KEY(?:\\+")?(?:\s*[=:]\s*|\s+)(?:\\+")?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?!\\*[^\s\w"']?["']?Bearer\s+\S|(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth|composio_api_key)\s*[=:])[^\s=:]+)/gi,
      "COMPOSIO_API_KEY=[redacted]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)(?!\\*[^\s\w"']?["']?Bearer\s+\S|(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth|composio_api_key)\s*[=:])[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:auth|authorization)\s*[=:]\s*)(?!\\*[^\s\w"']?["']?Bearer\s+\S|(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth|composio_api_key)\s*[=:])[^\s"',;&]+/gi,
      "$1[redacted]",
    );
  return redactJwts(assignmentsMasked);
}

export function sanitizeError(message: string) {
  // Scan assignments before the JSON walker. The walker splits a label from its quoted value,
  // and the value would otherwise stay visible. Decoded pieces use the same assignment scan.
  const assigned = redactCredentialJsonFields(redactComposioApiKeyAssignments(message), false);
  const redact = (value: string) => sanitizeSensitiveText(value, { decoded: true });
  return redactJsonStringsAndPlainText(assigned, redact, redact);
}

const OPENCODE_SESSION_ERROR = "OpenCode rejected this chat session. Send the message again.";

function looksLikeOpenCodeSessionError(message: string): boolean {
  return (
    /x-opencode-session/i.test(message) ||
    /session\s*(id|header|required|missing|invalid|expired|stale)/i.test(message) ||
    /model is unavailable/i.test(message)
  );
}

/**
 * Endpoints the user or operator runs and configures; a deployment-funded model never uses them.
 */
const OWN_ENDPOINT_PROVIDERS = new Set([OPENAI_COMPATIBLE_PROVIDER_ID, LOCAL_PROVIDER_ID]);

/**
 * One classification for retries, reporting and the run error view. A failure the view
 * attributes to the user's provider account, key, plan or model choice, or to the model's own
 * unusable output, is not a server fault. Anything it cannot place stays a plain error.
 * `provider` served `error`; `primaryProvider` served the first model of a fallback chain.
 * `failedAfterAccepting`: `provider` answered the request with a success status, then failed.
 */
export function modelFailure(
  error: string,
  message: string,
  {
    provider,
    primaryProvider,
    failedAfterAccepting = false,
  }: { provider: string; primaryProvider: string; failedAfterAccepting?: boolean },
): Error {
  // When every model failed, the run is only as clear as its least explained failure: an
  // unexplained part stays a server error, and a part the user must fix outranks bad output,
  // which outranks one that clears on its own. Skipped backups never ran, so they do not count.
  const fallback = parseModelFallbackFailure(message);
  const failures = fallback
    ? [
        modelFailureClass(fallback.primaryError, fallback.primaryError, primaryProvider),
        ...fallback.backups
          .filter((item) => item.status === "failed")
          .map((item) => modelFailureClass(item.reason, item.reason, item.provider)),
      ]
    : [modelFailureClass(error, message, provider, failedAfterAccepting)];
  const Failure = MODEL_FAILURE_RANK[Math.max(...failures)] ?? Error;
  return new Failure(message);
}

/** Least to most severe; a server fault (plain Error) is last. */
const MODEL_FAILURE_RANK = [TransientModelError, ModelOutputError, ModelAccountError, Error];

function modelFailureClass(
  error: string,
  message: string,
  provider: string,
  failedAfterAccepting = false,
): number {
  const { kind, recovery, status } = normalizeRunError(message);
  // Output diagnostics can quote generated text that looks like a timeout.
  if (kind === "output") return MODEL_FAILURE_RANK.indexOf(ModelOutputError);
  // OpenCode drops chat sessions on its side; the next send opens a new one.
  if (isTransientModelError(error) || message === OPENCODE_SESSION_ERROR)
    return MODEL_FAILURE_RANK.indexOf(TransientModelError);
  // A refresh token the provider no longer accepts; the credential is already retired.
  if (terminalOAuthRefreshErrorMarker(message))
    return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  if (kind || recovery) return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  // The user's own endpoint refused a request its model or settings cannot take. On a named
  // provider the same rejection more likely means Rakazo built the request wrong.
  if ((status === 400 || status === 422) && OWN_ENDPOINT_PROVIDERS.has(provider))
    return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  // The user's own endpoint took the request, then reported a failure of its own in the reply
  // with no status to place it: nothing Rakazo sent was refused, and another try can succeed.
  if (failedAfterAccepting && status === undefined && OWN_ENDPOINT_PROVIDERS.has(provider))
    return MODEL_FAILURE_RANK.indexOf(TransientModelError);
  return MODEL_FAILURE_RANK.indexOf(Error);
}

export function sanitizeProviderError(provider: string, message: string): string {
  const sanitized = sanitizeError(message);
  if (isOpenCodeProvider(provider) && looksLikeOpenCodeSessionError(sanitized)) {
    return OPENCODE_SESSION_ERROR;
  }
  return sanitized;
}
