import { TOOL_RESULT_PREVIEW_MAX_CHARS } from "@rakazo/contracts";
import {
  boundToolStepDetail,
  isVisualActionTool,
  redactSecrets,
  toolCallDetailLine,
} from "@rakazo/core";
import { sanitizeSensitiveText } from "./pi-runtime-errors.js";

/** Key endings that name a credential, compared without case, `_` or `-`. */
const CREDENTIAL_KEY_ENDINGS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "clientkey",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "sessionid",
];

/** Whole keys that name a credential but are too short to match as an ending. */
const CREDENTIAL_KEYS = new Set(["auth", "pass", "pwd", "pin", "otp"]);

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    CREDENTIAL_KEYS.has(normalized) ||
    CREDENTIAL_KEY_ENDINGS.some((ending) => normalized.endsWith(ending))
  );
}

/** A JSON member whose value is a string or a number: its key, then the value. */
const JSON_SCALAR_MEMBER = /("((?:[^"\\]|\\.)*)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g;

/**
 * A line shown in tool activity as it is, such as a command or a step's argument line: the
 * run's own secrets, known key and token shapes, and any JSON string or number under a
 * credential-named key are taken out, and nothing else changes.
 */
export function redactToolActivityLine(text: string, secrets: readonly string[]): string {
  return sanitizeSensitiveText(redactSecrets(text, secrets)).replace(
    JSON_SCALAR_MEMBER,
    (member, prefix: string, key: string) =>
      isCredentialKey(key) ? `${prefix}"[redacted]"` : member,
  );
}

/** Beyond this, text a tool returned is not parsed as JSON; it is redacted as a line. */
const JSON_PARSE_MAX_CHARS = 64_000;

/**
 * Text a tool returned, safe for the chat. When it is a JSON object or array as a whole, it
 * is redacted value by value, so a credential-named key's value goes whatever its type. JSON
 * with an integer too large to read exactly is left as text, so no number is misreported.
 */
export function redactToolActivityText(text: string, secrets: readonly string[]): string {
  const trimmed = text.trim();
  if (trimmed.length <= JSON_PARSE_MAX_CHARS && /^[[{]/.test(trimmed) && !/\d{16,}/.test(trimmed)) {
    try {
      return redactToolActivityJson(JSON.parse(trimmed), secrets);
    } catch {
      // Not JSON after all.
    }
  }
  return redactToolActivityLine(text, secrets);
}

/**
 * A tool's arguments or result as JSON for the activity view, safe for the chat: redacted
 * value by value before serializing, then once more as a whole, since a run secret or a token
 * shape can span values that only meet once joined.
 */
export function redactToolActivityJson(value: unknown, secrets: readonly string[]): string {
  return redactToolActivityLine(
    JSON.stringify(redactToolActivityValue(value, secrets), null, 2),
    secrets,
  );
}

/**
 * A tool's arguments or result made safe the same way, value by value, before anything
 * serializes it: a value under a credential-named key is dropped whole, and every other
 * string is redacted while it is still plain text, so JSON escaping cannot hide a secret.
 */
export function redactToolActivityValue(value: unknown, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redactToolActivityValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        redactToolActivityLine(key, secrets),
        // A flag such as `pin: true` says nothing secret; any other value goes whole.
        isCredentialKey(key) && item !== null && item !== "" && typeof item !== "boolean"
          ? "[redacted]"
          : redactToolActivityValue(item, secrets),
      ]),
    );
  }
  return typeof value === "string" ? redactToolActivityLine(value, secrets) : value;
}

/** Text cut to `max` characters once it is redacted, so a secret is never split by the cut. */
export function boundToolActivityText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const SHELL_TOOLS = new Set(["shell", "user_computer_shell"]);

/**
 * What a call's own event says about it, safe for the chat: its argument line, its arguments
 * as JSON, and a shell's whole command line. The arguments are redacted value by value first,
 * then each serialized form once more whole, since a run secret can span values it joins; each
 * is cut to length only afterwards, so a secret is never split by the cut. A shell's arguments
 * are its command, so it carries the command line instead of JSON.
 */
export function toolActivityCallFields(
  name: string,
  args: unknown,
  secrets: readonly string[],
): { detail?: string; input?: string; command?: string } {
  if (isVisualActionTool(name)) return {};
  const safeArgs = redactToolActivityValue(args, secrets);
  const line = toolCallDetailLine(safeArgs);
  const detail =
    line === undefined ? undefined : boundToolStepDetail(redactToolActivityLine(line, secrets));
  if (SHELL_TOOLS.has(name)) {
    const command = (safeArgs as { command?: unknown } | null)?.command;
    return {
      ...(detail === undefined ? {} : { detail }),
      ...(typeof command === "string" && command.trim()
        ? {
            command: boundToolActivityText(
              redactToolActivityLine(command, secrets),
              TOOL_RESULT_PREVIEW_MAX_CHARS,
            ),
          }
        : {}),
    };
  }
  const hasArgs = !!safeArgs && typeof safeArgs === "object" && Object.keys(safeArgs).length > 0;
  return {
    ...(hasArgs
      ? {
          input: boundToolActivityText(
            redactToolActivityLine(JSON.stringify(safeArgs, null, 2), secrets),
            TOOL_RESULT_PREVIEW_MAX_CHARS,
          ),
        }
      : {}),
  };
}
