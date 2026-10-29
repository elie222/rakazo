const REDACTED = "[Redacted]";
const REDACT_KEYS = new Set([
  "email",
  "prompt",
  "message",
  "messages",
  "body",
  "content",
  "text",
  "blocks",
  "parts",
  "input",
  "output",
  "stdout",
  "stderr",
  "arguments",
  "transcript",
  "completion",
  "html",
  "markdown",
  "query",
  "rawheaders",
  "headers",
  "passwd",
  "api_key",
]);
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;
const TOKEN_BUDGET_KEYS = new Set(["requestedmaxtokens", "effectivemaxtokens"]);

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name || "Error",
      message: redactSensitiveText(value.message),
    };
    if (typeof value.stack === "string" && value.stack.length > 0) {
      output.stack = redactSensitiveText(value.stack);
    }
    if (value.cause !== undefined) {
      output.cause =
        typeof value.cause === "string"
          ? redactSensitiveText(value.cause)
          : redactValue(value.cause, seen);
    }
    return output;
  }
  if (value instanceof Date) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = shouldRedactKey(key, nested) ? REDACTED : redactValue(nested, seen);
  }
  return output;
}

export function redactBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  return redactValue(bindings) as Record<string, unknown>;
}

// Consume a failed local-part candidate once instead of retrying at every dot or hyphen.
const EMAIL_CANDIDATE = /\b[A-Z0-9._%+-]+(?:@[A-Z0-9.-]+\.[A-Z]{2,}\b)?/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|secret|token|authorization|apikey|api_key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi;
const JSON_SECRET_FIELD =
  /"(password|passwd|secret|token|authorization|apikey|api_key|accesstoken|refreshtoken|email|cookie)"\s*:\s*"(?:\\.|[^"\\])*"/gi;
const BARE_SECRET =
  /\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ak_|ck_)[A-Za-z0-9]+)\b/g;
// Profile paths leak the account name; leave later drive prefixes available for independent redaction.
const WINDOWS_PROFILE = /[A-Z]:[\\/]Users[\\/](?:(?![A-Z]:[\\/])[^\\/\r\n])+/gi;
const POSIX_PROFILE = /(?:\/Users\/|\/home\/)[^/\s]+/g;

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL_CANDIDATE, (candidate) => (candidate.includes("@") ? REDACTED : candidate))
    .replace(JSON_SECRET_FIELD, `"$1":"${REDACTED}"`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(BARE_SECRET, REDACTED)
    .replace(WINDOWS_PROFILE, "[user]")
    .replace(POSIX_PROFILE, "/[user]");
}

function shouldRedactKey(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  // Only known numeric counters bypass token redaction; strings and containers may be secrets.
  if (
    TOKEN_BUDGET_KEYS.has(normalized.replaceAll("_", "")) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return false;
  }
  return REDACT_KEYS.has(normalized) || SECRET_KEY.test(normalized);
}
