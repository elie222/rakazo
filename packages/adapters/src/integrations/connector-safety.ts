import { redactJsonStringsAndPlainText, redactSecrets, sliceWellFormed } from "@rakazo/core";

const CONNECTOR_JSON_CONTAINER_START =
  /(?:\{\s*(?:["}]|$)|\[\s*(?:["{[\]]|(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[\s,\]]|$)))/;
const CONNECTOR_RAW_JSON_CONTAINER_START =
  /(?:\{(?:\s|\\[nrt])*(?:\\*"|\}|$)|\[(?:\s|\\[nrt])*(?:\\*"|[{[\]]|(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s|\\[nrt]|[,\]$])))/;
const CONNECTOR_DECODED_DEFERRED_BEARER_FOLLOWS = new RegExp(
  `Bearer(?:[^\\S\\r\\n]+(?!(?:\\s|\\S*Bearer\\s+\\S))\\S|\\s+(?!(?:\\s|${CONNECTOR_JSON_CONTAINER_START.source}|\\S*Bearer\\s+\\S))\\S)`,
);
const CONNECTOR_DECODED_BEARER_RE = new RegExp(
  `Bearer\\s+(?!${CONNECTOR_DECODED_DEFERRED_BEARER_FOLLOWS.source})\\S+`,
  "gi",
);
const CONNECTOR_PLAIN_DEFERRED_BEARER_FOLLOWS = new RegExp(
  `Bearer(?:[^\\S\\r\\n]+(?!(?:\\s|\\\\[nrt]|\\S*Bearer(?:\\s|\\\\[nrt])+\\S))\\S|\\s+(?!(?:\\s|\\\\[nrt]|${CONNECTOR_JSON_CONTAINER_START.source}|\\S*Bearer(?:\\s|\\\\[nrt])+\\S))\\S|\\s*\\\\[nrt](?:\\s|\\\\[nrt])*(?!(?:\\s|\\\\[nrt]|${CONNECTOR_RAW_JSON_CONTAINER_START.source}|\\S*Bearer(?:\\s|\\\\[nrt])+\\S))(?:\\\\"|["']|\\\\(?![nrt"\\\\])|[^\\s"',;&}:\\]\\\\]))`,
);
const CONNECTOR_ADJACENT_CREDENTIAL_START =
  /(?:Bearer\s|(?:api[_-]?key|access[_-]?token|password|secret|authorization|auth)\s*[=:]\s*(?:\[redacted\]|["']\[redacted\]["']))/;
const CONNECTOR_RAW_UNIT =
  /(?:[=:](?:\\"(?!\s*[:,}\]\r\n]|$)(?:\\[^"\r\n]|[^"\\\r\n])+(?:\\")?|"(?!\s*[:,}\]\r\n]|$)(?:\\[^\r\n]|[^"\\\r\n])+"?|'(?!\s*[:,}\]\r\n]|$)(?:\\[^\r\n]|[^'"\\\r\n])+'?)|=|:(?!\s|$|["']|\\")|\[redacted\]|\[(?!redacted\])|\\(?![nrt"\\])|[^\s"',;&}=:\]\\[])/;
const CONNECTOR_SUFFIX_UNIT = new RegExp(
  `(?:(?!${CONNECTOR_ADJACENT_CREDENTIAL_START.source}|${CONNECTOR_RAW_JSON_CONTAINER_START.source})${CONNECTOR_RAW_UNIT.source})`,
);
const CONNECTOR_PLAIN_BEARER_RE = new RegExp(
  `Bearer\\s+(?!${CONNECTOR_PLAIN_DEFERRED_BEARER_FOLLOWS.source}|\\[redacted\\](?!${CONNECTOR_SUFFIX_UNIT.source}))(?:\\\\"(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^"\\r\\n]|[^"\\\\\\r\\n])+(?:\\\\"${CONNECTOR_SUFFIX_UNIT.source}*)?|"(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^"\\\\\\r\\n])+(?:"${CONNECTOR_SUFFIX_UNIT.source}*)?|'(?!\\s*[:,}\\]\\r\\n]|$)(?:\\\\[^\\r\\n]|[^'"\\\\\\r\\n])+(?:'${CONNECTOR_SUFFIX_UNIT.source}*)?|\\[redacted\\]${CONNECTOR_SUFFIX_UNIT.source}+|(?:${CONNECTOR_RAW_UNIT.source})+)`,
  "gi",
);
const CONNECTOR_ESCAPED_WS_BEARER_RE = /Bearer\s*\\[nrt](?:\s|\\[nrt])*/gi;
const CONNECTOR_ESCAPED_BEARER_NEXT_STICKY = /Bearer(?:\s|\\[nrt])+/iy;
const CONNECTOR_RAW_JSON_CONTAINER_STICKY = new RegExp(
  CONNECTOR_RAW_JSON_CONTAINER_START.source,
  "y",
);
const CONNECTOR_RAW_UNIT_STICKY = new RegExp(CONNECTOR_RAW_UNIT.source, "y");
const CONNECTOR_SUFFIX_UNIT_STICKY = new RegExp(CONNECTOR_SUFFIX_UNIT.source, "y");

function consumeConnectorSuffix(text: string, from: number): number {
  let cur = from;
  while (cur < text.length) {
    CONNECTOR_SUFFIX_UNIT_STICKY.lastIndex = cur;
    if (!CONNECTOR_SUFFIX_UNIT_STICKY.test(text)) break;
    cur = CONNECTOR_SUFFIX_UNIT_STICKY.lastIndex;
  }
  return cur;
}

function redactConnectorEscapedWhitespaceBearers(text: string): string {
  if (!text.includes("\\")) return text;
  CONNECTOR_ESCAPED_WS_BEARER_RE.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (
    let match = CONNECTOR_ESCAPED_WS_BEARER_RE.exec(text);
    match !== null;
    match = CONNECTOR_ESCAPED_WS_BEARER_RE.exec(text)
  ) {
    const start = match.index;
    const valueStart = start + match[0].length;
    if (valueStart >= text.length) break;
    CONNECTOR_ESCAPED_BEARER_NEXT_STICKY.lastIndex = valueStart;
    if (CONNECTOR_ESCAPED_BEARER_NEXT_STICKY.test(text)) continue;
    CONNECTOR_RAW_JSON_CONTAINER_STICKY.lastIndex = valueStart;
    if (CONNECTOR_RAW_JSON_CONTAINER_STICKY.test(text)) continue;
    let end = valueStart;
    if (text.startsWith("[redacted]", valueStart)) {
      CONNECTOR_SUFFIX_UNIT_STICKY.lastIndex = valueStart + 10;
      if (!CONNECTOR_SUFFIX_UNIT_STICKY.test(text)) continue;
      end = consumeConnectorSuffix(text, valueStart + 10);
    } else if (text[valueStart] === "\\" && text[valueStart + 1] === '"') {
      let cur = valueStart + 2;
      let closed = false;
      while (cur < text.length) {
        const ch = text[cur]!;
        if (ch === "\n" || ch === "\r" || ch === '"') break;
        if (ch === "\\") {
          const next = text[cur + 1];
          if (next === '"') {
            cur += 2;
            closed = true;
            break;
          }
          if (next === "n" || next === "r") break;
          cur += next === undefined ? 1 : 2;
          continue;
        }
        cur += 1;
      }
      end = closed ? consumeConnectorSuffix(text, cur) : cur;
    } else if (text[valueStart] === '"' || text[valueStart] === "'") {
      const quote = text[valueStart]!;
      if (quote === '"') {
        let probe = valueStart + 1;
        while (
          probe < text.length &&
          text[probe] !== "\n" &&
          text[probe] !== "\r" &&
          /\s/.test(text[probe]!)
        ) {
          probe += 1;
        }
        if (probe >= text.length || /[:,}\]\r\n]/.test(text[probe]!)) continue;
      }
      let cur = valueStart + 1;
      let closed = false;
      while (cur < text.length) {
        const ch = text[cur]!;
        if (ch === "\n" || ch === "\r") break;
        if (quote === "'" && ch === '"') break;
        if (ch === "\\") {
          const next = text[cur + 1];
          if (next === "n" || next === "r" || (quote === "'" && next === '"')) break;
          cur += next === undefined ? 1 : 2;
          continue;
        }
        cur += 1;
        if (ch === quote) {
          closed = true;
          break;
        }
      }
      end = closed ? consumeConnectorSuffix(text, cur) : cur;
    } else {
      while (end < text.length) {
        CONNECTOR_RAW_UNIT_STICKY.lastIndex = end;
        if (!CONNECTOR_RAW_UNIT_STICKY.test(text)) break;
        end = CONNECTOR_RAW_UNIT_STICKY.lastIndex;
      }
    }
    if (end <= valueStart) continue;
    out += `${text.slice(cursor, start)}Bearer [redacted]`;
    cursor = end;
    CONNECTOR_ESCAPED_WS_BEARER_RE.lastIndex = cursor;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => Boolean(signal)));
}

/** The error's message, or for one without (e.g. a happy-eyeballs AggregateError) what its
 * inner errors, cause, name or code say, so a failure never reads as an empty string. */
export function connectorErrorMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) {
    if (typeof error === "string") return error || "unknown error";
    try {
      return String(error) || "unknown error";
    } catch {
      return "unknown error";
    }
  }
  if (error.message) return error.message;
  if (depth < 3) {
    const inner = error instanceof AggregateError ? error.errors[0] : error.cause;
    if (inner !== undefined) return connectorErrorMessage(inner, depth + 1);
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? `${error.name} ${code}`
    : `${error.name} without a message`;
}

export function sanitizeConnectorError(
  error: unknown,
  secrets: string[] = [],
  options?: { maxChars?: number },
): string {
  const message = connectorErrorMessage(error);
  const sanitizeDecoded = (value: string) =>
    redactSecrets(value, secrets)
      .replace(CONNECTOR_DECODED_BEARER_RE, "Bearer [redacted]")
      .replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]");
  const sanitizePlain = (value: string) =>
    redactConnectorEscapedWhitespaceBearers(
      redactSecrets(value, secrets).replace(CONNECTOR_PLAIN_BEARER_RE, "Bearer [redacted]"),
    ).replace(/trg_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted]");
  const cleaned = redactJsonStringsAndPlainText(message, sanitizeDecoded, sanitizePlain, secrets);
  const maxChars = options?.maxChars ?? 2_000;
  return Number.isFinite(maxChars) ? sliceWellFormed(cleaned, maxChars) : cleaned;
}

export function redactConnectorPayload(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  try {
    return redactPayloadValue(JSON.parse(JSON.stringify(value)), secrets);
  } catch {
    return { ok: true };
  }
}

function redactPayloadValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPayloadValue(item, secrets));
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    const serialized = String(value);
    return redactSecrets(serialized, secrets) === serialized ? value : "[redacted]";
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactSecrets(key, secrets),
      redactPayloadValue(item, secrets),
    ]),
  );
}
