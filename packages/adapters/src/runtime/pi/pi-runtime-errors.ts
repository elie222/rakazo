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

const CREDENTIAL_KEY_WORD = "(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth)";
const BARE_CREDENTIAL_KEY_STICKY = new RegExp(
  `(?:composio_api_key|${CREDENTIAL_KEY_WORD})(?=[^A-Za-z0-9_-]|$)`,
  "iy",
);
const PREFIXED_CREDENTIAL_KEY_STICKY = new RegExp(
  `[\\w-]*${CREDENTIAL_KEY_WORD}(?=[^A-Za-z0-9_-]|$)`,
  "iy",
);
const BEARER_FOLLOWS_STICKY = /\\*[^\s\w"']?["']?Bearer\s+\S/iy;
const COMPOSIO_KEY_PREFIX_RE =
  /COMPOSIO_API_KEY(?:\\(?:\\\\)*")?(?:\s*[=:]\s*|\s+)(?:\\(?:\\\\)*")?/gi;
const SECRET_ASSIGNMENT_KEY_RE = /(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*/gi;
const AUTH_ASSIGNMENT_KEY_RE = /(?:auth|authorization)\s*[=:]\s*/gi;

function isJsonEscapedSpace(text: string, index: number): boolean {
  return (
    text[index] === "\\" &&
    (text[index + 1] === "n" || text[index + 1] === "r" || text[index + 1] === "t")
  );
}

function skipSpaceOrJsonEscapedSpace(text: string, pos: number): number {
  let cur = pos;
  while (cur < text.length) {
    if (/\s/.test(text[cur]!)) {
      cur += 1;
      continue;
    }
    if (isJsonEscapedSpace(text, cur)) {
      cur += 2;
      continue;
    }
    break;
  }
  return cur;
}

/**
 * True when `text` at `pos` opens a valid JSON object header (`{}` or `{"key":`, handling raw or
 * backslash-escaped quotes and whitespace/escaped newlines) in linear time.
 */
function startsWithJsonObjectHeader(text: string, pos: number): boolean {
  if (text[pos] !== "{") return false;
  let cur = skipSpaceOrJsonEscapedSpace(text, pos + 1);
  if (text[cur] === "}") return true;
  if (text[cur] === '"') {
    cur += 1;
    while (cur < text.length) {
      const ch = text[cur]!;
      if (ch === "\n" || ch === "\r") return false;
      if (ch === "\\") {
        if (cur + 1 >= text.length) return false;
        cur += 2;
        continue;
      }
      if (ch === '"') {
        cur = skipSpaceOrJsonEscapedSpace(text, cur + 1);
        return text[cur] === ":";
      }
      cur += 1;
    }
    return false;
  }
  if (text[cur] === "\\") {
    const slashStart = cur;
    while (cur < text.length && text[cur] === "\\") cur += 1;
    const openSlashes = cur - slashStart;
    if (text[cur] !== '"') return false;
    cur += 1;
    while (cur < text.length) {
      const ch = text[cur]!;
      if (ch === "\n" || ch === "\r") return false;
      if (ch === "\\") {
        const runStart = cur;
        while (cur < text.length && text[cur] === "\\") cur += 1;
        const runLen = cur - runStart;
        if (text[cur] === '"') {
          if (runLen === openSlashes) {
            cur = skipSpaceOrJsonEscapedSpace(text, cur + 1);
            return text[cur] === ":";
          }
          cur += 1;
        }
        continue;
      }
      if (ch === '"') return false;
      cur += 1;
    }
    return false;
  }
  return false;
}

function startsWithBearer(text: string, pos: number): boolean {
  BEARER_FOLLOWS_STICKY.lastIndex = pos;
  return BEARER_FOLLOWS_STICKY.test(text);
}

function trailingWhitespaceAfterSeparator(prefix: string): string {
  let end = prefix.length;
  while (end > 0 && /\s/.test(prefix[end - 1]!)) end -= 1;
  return prefix.slice(end);
}

function defersToNextCredentialKey(
  text: string,
  valueStart: number,
  ws: string,
  requireSpaceAfterSep: boolean,
): boolean {
  const crossedLine =
    ws.includes("\n") || ws.includes("\r") || ws.includes("\\n") || ws.includes("\\r");
  const keyRe = crossedLine ? PREFIXED_CREDENTIAL_KEY_STICKY : BARE_CREDENTIAL_KEY_STICKY;
  keyRe.lastIndex = valueStart;
  const keyMatch = keyRe.exec(text);
  if (!keyMatch) return false;
  BARE_CREDENTIAL_KEY_STICKY.lastIndex = valueStart;
  const isBare = BARE_CREDENTIAL_KEY_STICKY.test(text);
  if (ws.length === 0 && !isBare) return false;
  let pos = valueStart + keyMatch[0].length;
  while (pos < text.length && text[pos] !== "\n" && text[pos] !== "\r" && /\s/.test(text[pos]!)) {
    pos += 1;
  }
  const sep = text[pos];
  if (sep !== "=" && sep !== ":") return false;
  pos += 1;
  let sameLineSpace = 0;
  while (pos < text.length && text[pos] !== "\n" && text[pos] !== "\r" && /\s/.test(text[pos]!)) {
    pos += 1;
    sameLineSpace += 1;
  }
  if (pos < text.length && text[pos] !== "\n" && text[pos] !== "\r") {
    if (!requireSpaceAfterSep) return ws.length > 0;
    return sameLineSpace > 0 || text[pos] === '"' || text[pos] === "'";
  }
  if (!crossedLine || !isBare) return false;
  while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
  return pos < text.length;
}

function scanQuotedValueEnd(text: string, open: number, decoded: boolean): number {
  const quote = text[open];
  if (quote !== '"' && quote !== "'") return -1;
  if (!decoded && quote === '"') {
    let probe = open + 1;
    while (probe < text.length && /\s/.test(text[probe]!)) probe += 1;
    if (
      probe >= text.length ||
      text[probe] === "," ||
      text[probe] === "}" ||
      text[probe] === "]" ||
      text[probe] === ":"
    ) {
      return -1;
    }
  }
  let cur = open + 1;
  while (cur < text.length) {
    const ch = text[cur]!;
    if (ch === "\\") {
      if (cur + 1 >= text.length) return -1;
      cur += 2;
      continue;
    }
    if (ch === quote) return cur + 1;
    if (!decoded && quote === "'" && ch === '"') return -1;
    cur += 1;
  }
  return -1;
}

/**
 * End of a closed single-line quoted value (`"..."` or `'...'`), or -1. In raw mode a single-quoted
 * scan stops before an unescaped `"` and a double-quoted scan rejects an opening `"` that looks
 * like the closing delimiter of an outer JSON string (`","`, `"}`, `"]`).
 */
function scanSingleLineQuotedValueEnd(text: string, open: number, decoded: boolean): number {
  const quote = text[open];
  if (quote !== '"' && quote !== "'") return -1;
  if (!decoded && quote === '"') {
    let probe = open + 1;
    while (probe < text.length && /\s/.test(text[probe]!)) probe += 1;
    if (
      probe >= text.length ||
      text[probe] === "," ||
      text[probe] === "}" ||
      text[probe] === "]" ||
      text[probe] === ":"
    ) {
      return -1;
    }
  }
  let cur = open + 1;
  while (cur < text.length) {
    const ch = text[cur]!;
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      if (cur + 1 >= text.length || text[cur + 1] === "\n" || text[cur + 1] === "\r") return -1;
      cur += 2;
      continue;
    }
    if (ch === quote) return cur + 1;
    if (!decoded && quote === "'" && ch === '"') return -1;
    cur += 1;
  }
  return -1;
}

/** Index of the closing `\"` of a JSON-escaped quoted value starting at `open`, or -1. */
function scanEscapedDoubleQuotedEnd(text: string, open: number): number {
  let cur = open + 2;
  while (cur < text.length) {
    const ch = text[cur]!;
    if (ch === "\n" || ch === "\r" || ch === '"') return -1;
    if (ch === "\\") {
      const runStart = cur;
      while (cur < text.length && text[cur] === "\\") cur += 1;
      const runLen = cur - runStart;
      if (text[cur] === '"') {
        if (runLen % 4 === 1) return cur - 1;
        if (runLen % 2 === 0) return -1;
        cur += 1;
      }
      continue;
    }
    cur += 1;
  }
  return -1;
}

function redactComposioRegexAssignments(text: string, decoded: boolean): string {
  COMPOSIO_KEY_PREFIX_RE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (
    let match = COMPOSIO_KEY_PREFIX_RE.exec(text);
    match !== null;
    match = COMPOSIO_KEY_PREFIX_RE.exec(text)
  ) {
    const start = match.index;
    const valueStart = start + match[0].length;
    if (valueStart >= text.length) break;
    if (
      text.startsWith("[redacted]", valueStart) &&
      startsWithJsonObjectHeader(text, valueStart + 10)
    ) {
      out += `${text.slice(cursor, start)}COMPOSIO_API_KEY=[redacted]`;
      cursor = valueStart + 10;
      COMPOSIO_KEY_PREFIX_RE.lastIndex = cursor;
      continue;
    }
    const quotedEnd = scanQuotedValueEnd(text, valueStart, decoded);
    if (quotedEnd >= 0) {
      out += `${text.slice(cursor, start)}COMPOSIO_API_KEY=[redacted]`;
      cursor = quotedEnd;
      COMPOSIO_KEY_PREFIX_RE.lastIndex = cursor;
      continue;
    }
    if (startsWithBearer(text, valueStart)) continue;
    const ws = trailingWhitespaceAfterSeparator(match[0]);
    if (defersToNextCredentialKey(text, valueStart, ws, false)) continue;
    let end = valueStart;
    while (end < text.length && !/[\s=:]/.test(text[end]!)) {
      if (!decoded && text[end] === '"') {
        let slashes = 0;
        while (end - 1 - slashes >= valueStart && text[end - 1 - slashes] === "\\") slashes += 1;
        if (slashes % 2 === 0) break;
      }
      end += 1;
    }
    if (end === valueStart) continue;
    out += `${text.slice(cursor, start)}COMPOSIO_API_KEY=[redacted]`;
    cursor = end;
    COMPOSIO_KEY_PREFIX_RE.lastIndex = cursor;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

function redactGenericAssignmentsByPattern(
  text: string,
  pattern: RegExp,
  decoded: boolean,
): string {
  pattern.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index;
    let valueStart = start + match[0].length;
    if (valueStart >= text.length) break;
    let ws = trailingWhitespaceAfterSeparator(match[0]);
    if (!decoded && isJsonEscapedSpace(text, valueStart)) {
      const afterEscapedWs = skipSpaceOrJsonEscapedSpace(text, valueStart);
      ws += text.slice(valueStart, afterEscapedWs);
      valueStart = afterEscapedWs;
      if (valueStart >= text.length) break;
    }
    if (startsWithBearer(text, valueStart)) continue;
    if (
      text.startsWith("[redacted]", valueStart) &&
      startsWithJsonObjectHeader(text, valueStart + 10)
    ) {
      continue;
    }
    if (defersToNextCredentialKey(text, valueStart, ws, true)) continue;
    if (!decoded && text[valueStart] === "\\" && text[valueStart + 1] === '"') {
      const closeAt = scanEscapedDoubleQuotedEnd(text, valueStart);
      if (closeAt >= 0) {
        out += `${text.slice(cursor, valueStart)}\\"[redacted]\\"`;
        cursor = closeAt + 2;
        pattern.lastIndex = cursor;
        continue;
      }
      let end = valueStart + 2;
      while (end < text.length && !/[\s"',;&]/.test(text[end]!)) end += 1;
      if (end < text.length && text[end] === '"') {
        let slashes = 0;
        while (end - 1 - slashes >= valueStart + 2 && text[end - 1 - slashes] === "\\") {
          slashes += 1;
        }
        if (slashes % 2 === 1) end -= 1;
      }
      out += `${text.slice(cursor, valueStart)}\\"[redacted]`;
      cursor = end;
      pattern.lastIndex = cursor;
      continue;
    }
    if (text[valueStart] === '"' || text[valueStart] === "'") {
      const quote = text[valueStart]!;
      const quoteEnd = scanSingleLineQuotedValueEnd(text, valueStart, decoded);
      if (quoteEnd > valueStart + 2) {
        out += `${text.slice(cursor, valueStart)}${quote}[redacted]${quote}`;
        cursor = quoteEnd;
        pattern.lastIndex = cursor;
      }
      continue;
    }
    let end = valueStart;
    while (end < text.length && !/[\s"',;&]/.test(text[end]!)) end += 1;
    if (!decoded && end < text.length && text[end] === '"') {
      let slashes = 0;
      while (end - 1 - slashes >= valueStart && text[end - 1 - slashes] === "\\") slashes += 1;
      if (slashes % 2 === 1) end -= 1;
    }
    if (end === valueStart) continue;
    out += `${text.slice(cursor, valueStart)}[redacted]`;
    cursor = end;
    pattern.lastIndex = cursor;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

export function sanitizeSensitiveText(message: string, options?: { decoded?: boolean }) {
  const decoded = options?.decoded === true;
  const bearerMasked = redactPlainBearerTokens(message, options);
  const composioMasked = redactComposioApiKeyAssignments(bearerMasked);
  const keyMasked = composioMasked
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]");
  const composioRegexMasked = redactComposioRegexAssignments(keyMasked, decoded);
  const secretMasked = redactGenericAssignmentsByPattern(
    composioRegexMasked,
    SECRET_ASSIGNMENT_KEY_RE,
    decoded,
  );
  const assignmentsMasked = redactGenericAssignmentsByPattern(
    secretMasked,
    AUTH_ASSIGNMENT_KEY_RE,
    decoded,
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
