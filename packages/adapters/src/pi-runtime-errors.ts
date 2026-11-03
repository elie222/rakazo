import {
  isTransientModelError,
  ModelAccountError,
  ModelOutputError,
  ModelProviderError,
  modelFailureReason,
  TransientModelError,
} from "@rakazo/adapter-kit";
import {
  MODEL_OUTPUT_LIMIT_ERROR,
  normalizeRunError,
  parseModelFallbackFailure,
} from "@rakazo/core";
import { terminalOAuthRefreshErrorMarker } from "./pi-oauth.js";
import { isOpenCodeProvider } from "./pi-runtime-stream.js";

/** Keep controlled account recovery advice without retaining upstream diagnostic text. */
export function modelRunFailureReason(error: ModelProviderError): string {
  if (!(error instanceof ModelAccountError)) return modelFailureReason(error);
  const providerMessage = stripSavedErrorKind(error.message);
  const normalized = normalizeRunError(
    terminalOAuthRefreshErrorMarker(providerMessage) ? "authentication_error" : providerMessage,
    (message, values) => {
      // Keep a machine-readable reset below instead of the localized calendar label.
      if (message === "{summary} Resets {date}.") return String(values?.summary ?? "");
      return message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
        key === "provider" ? "Your model provider" : String(values?.[key] ?? placeholder),
      );
    },
  );
  if (!normalized.kind) return modelFailureReason(error);
  const reset = normalized.resetAt
    ? ` Resets at ${new Date(normalized.resetAt).toISOString()}.`
    : "";
  const status = error.httpStatus ? ` HTTP ${error.httpStatus}.` : "";
  return `ModelAccountError[${normalized.kind}]: ${normalized.summary}${reset}${status}`;
}

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

export function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}

export function sanitizeError(message: string) {
  return sanitizeSensitiveText(message);
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
 * One classification for retries, reporting and the run error view. A failure the view
 * attributes to the user's provider account, key, plan or model choice, or to the model's own
 * unusable output, is not a server fault. Unclassified provider failures keep the generic provider error type.
 */
export function modelFailure(error: string, message: string, diagnostics?: unknown): Error {
  // When every model failed, the run is only as clear as its least explained failure: an
  // unexplained part stays a generic provider failure, and a part the user must fix outranks bad output,
  // which outranks one that clears on its own. Skipped backups never ran, so they do not count.
  const fallback = parseModelFallbackFailure(message);
  const failures = fallback
    ? [
        fallback.primaryError,
        ...fallback.backups.filter((item) => item.status === "failed").map((item) => item.reason),
      ].map((part) => modelFailureClass(part, part))
    : [modelFailureClass(error, message)];
  const Failure = MODEL_FAILURE_RANK[Math.max(...failures)] ?? ModelProviderError;
  return new Failure(message, diagnostics);
}

/** Least to most severe; an unclassified provider failure is last. */
const MODEL_FAILURE_RANK = [
  TransientModelError,
  ModelOutputError,
  ModelAccountError,
  ModelProviderError,
];

function stripSavedErrorKind(message: string): string {
  return message.replace(
    /^\s*(?:(?:ModelAccountError|ModelOutputError|ModelProviderError|TransientModelError)(?:\[\w+\])?:\s*)+/,
    "",
  );
}

function modelFailureClass(error: string, message: string): number {
  const providerError = stripSavedErrorKind(error);
  const providerMessage = stripSavedErrorKind(message);
  const { kind } = normalizeRunError(providerMessage);
  // Output diagnostics can quote generated text that looks like a timeout.
  if (kind === "output") return MODEL_FAILURE_RANK.indexOf(ModelOutputError);
  // OpenCode drops chat sessions on its side; the next send opens a new one.
  if (isTransientModelError(providerError) || providerMessage === OPENCODE_SESSION_ERROR)
    return MODEL_FAILURE_RANK.indexOf(TransientModelError);
  // A refresh token the provider no longer accepts; the credential is already retired.
  if (terminalOAuthRefreshErrorMarker(providerMessage))
    return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  if (kind) return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  return MODEL_FAILURE_RANK.indexOf(ModelProviderError);
}

export function sanitizeProviderError(provider: string, message: string): string {
  const sanitized = sanitizeError(message);
  if (isOpenCodeProvider(provider) && looksLikeOpenCodeSessionError(sanitized)) {
    return OPENCODE_SESSION_ERROR;
  }
  return sanitized;
}
