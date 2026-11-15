const REDACTED = "[Redacted]";
const USER = "[user]";
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
]);
// One list for structured keys, quoted fields and free-text assignments.
const SECRET_NAMES = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credential",
  "apikey",
  "api_key",
  "api-key",
].join("|");
const SECRET_KEY = new RegExp(SECRET_NAMES);
const SECRET_WORD = new RegExp(`${SECRET_NAMES}|email`, "i");
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

// While the rules run, each marker is one character that no key, name or token can contain, so a
// rule never mistakes an earlier redaction for text and already redacted text comes back unchanged.
const REDACTED_MARK = "\uFDD0";
const USER_MARK = "\uFDD1";
const MARKS = REDACTED_MARK + USER_MARK;
const WRITTEN_MARKER = /\[Redacted\]|\[user\]/g;
const MARK = new RegExp(`[${MARKS}]`, "g");

// An unfinished quoted value consumes the rest of the text as well. A value already redacted is
// left alone, whatever a later rule made of the words after it.
const INVALID_HEADER_VALUE = new RegExp(
  String.raw`Headers\.append: (\\?")(?!${REDACTED_MARK}\1)[\s\S]*?(?:\1 is an invalid header value\.|$)`,
  "g",
);

// Letters beyond ASCII in scripts that put spaces between words, so a match ends where a word does.
const WORLD = String.raw`\u00C0-\u1FFF`;
// Profile paths leak the account name; leave later drive prefixes available for independent
// redaction. A name may hold earlier redactions, but one that is only a redaction is already gone.
const WINDOWS_NAME = String.raw`(?![A-Z]:[\\/])[^\\/\r\n`;
const WINDOWS_PROFILE = String.raw`[A-Z]:[\\/]Users[\\/][${MARKS}]*(?:${WINDOWS_NAME}${MARKS}])(?:${WINDOWS_NAME}])*`;
// A name may hold a few more words when the path continues straight after them.
const MORE_WORDS = String.raw`(?: [\w.${WORLD}${MARKS}-]+){1,3}(?=\/)`;
const POSIX_PROFILE = String.raw`(?:\/Users\/|\/home\/)(?:[${MARKS}]*[^/\s${MARKS}][^/\s]*(?:${MORE_WORDS})?|[${MARKS}]+${MORE_WORDS})`;

const QUOTE = String.raw`\\{0,8}["']`;
const SEPARATOR = String.raw`\s*(?::|=>?)\s*`;
const STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
// Quoted at any escaping depth; an escaped quote inside an escaped value has a backslash before it.
const quoted = (name: string) =>
  String.raw`(?=(?<${name}>${QUOTE}))(?:["'](?:\\[\s\S]|(?!\k<${name}>)[^\\])*|\\{1,8}["'][\s\S]*?(?<!\\))\k<${name}>`;
// A list or object on one level.
const BRACKETED = String.raw`\[(?:${STRING}|[^\][{}"])*\]|\{(?:${STRING}|[^{}[\]"])*\}`;
// A quote that never closes, or a nested list or object, takes the rest of its line.
const UNCLOSED = String.raw`${QUOTE}[^\n]*|[[{][^\n]*`;
const CREDENTIAL = String.raw`(?:(?:basic|bearer|digest|token)\s+)?\S+`;
// A header goes on after a comma or semicolon for as long as `name=value` parameters follow. A
// parameter with a secret name is left to start a match of its own.
const PARAMETERS = String.raw`(?:(?<=[,;])[ \t]+(?![\w.-]*?(?:${SECRET_NAMES}))[\w.-]+=(?:"[^"\n]*")?\S*)*`;
const KEY_START = String.raw`(?<![\w-])`;
// A value after a secret-named key: `key=value`, `"key": value`, `key => value` or `--key value`.
// Each key starts once, at the start of its word, and its lookahead admits only words that contain
// a secret name, so a long word is scanned once rather than once per name inside it.
const KEYED_SECRET = new RegExp(
  [
    // A quoted key may be dotted and follows the structured rule for addresses.
    String.raw`${KEY_START}(?:((?<=["'])(?=[\w.-]*?(?:${SECRET_NAMES}|email))[\w.-]+(?=${QUOTE})`,
    String.raw`|(?=[\w-]*?(?:${SECRET_NAMES}))[\w-]+)(${QUOTE})?(${SEPARATOR})`,
    // A flag starts its word; after a redaction it is the rest of a word that was not a flag.
    // Looking for the value's first character here keeps a long run of spaces from being retried.
    String.raw`|(?<![${MARKS}])(--(?=[\w-]*?(?:${SECRET_NAMES}))[\w-]+[ \t]+)(?!-))(?=\S)`,
    // An earlier redaction stands alone, so redacting twice cannot take more than redacting once.
    `(?:[${MARKS}]`,
    // After a quoted key the value ends where its field does, so the fields beside it stay.
    String.raw`|(?<=["']${SEPARATOR})(?:${quoted("field")}|${BRACKETED}|${UNCLOSED}|[^\s,}\]]+)`,
    // Elsewhere what is glued to the closing quote goes too, up to a quote that may open a field.
    String.raw`|${quoted("free")}[^\s"']*|(?:${BRACKETED})\S*|${UNCLOSED}`,
    // A profile path is one value although the account name in it may hold spaces.
    String.raw`|(?:${WINDOWS_PROFILE}|${POSIX_PROFILE})\S*`,
    // Whatever the scheme, its credential goes with it.
    String.raw`|(?<=authorization[\w-]*${SEPARATOR})(?:[a-z][\w-]*[ \t]+)?\S+${PARAMETERS}`,
    String.raw`|(?<=cookie[\w-]*${SEPARATOR})${CREDENTIAL}${PARAMETERS}`,
    `|${CREDENTIAL})`,
  ].join(""),
  "gi",
);

const BEARER = /\bBearer\s+[^\s"',;&]+/gi;

const URL_END = String.raw`\s"'<>,;)\]}\\&/?#\x60`;
const HOST = String.raw`(?:[A-Za-z0-9.${WORLD}-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?=[${URL_END}]|$)`;
// The password in `scheme://user:password@host`, whatever characters it holds: up to the first
// `@` that a host and the end of the URL follow, or else to the last `@` before the path, or
// the last one at all. A number that ends where a URL can is a port, not a password.
const URL_CREDENTIALS = new RegExp(
  String.raw`(:\/\/[^:[${URL_END}${MARKS}]*:)(?:${REDACTED_MARK}@|(?!\d{0,5}(?:[${URL_END}]|$))` +
    String.raw`(?:[^\s${MARKS}]{0,128}?@(?=${HOST})|[^\s/?#${MARKS}]*@` +
    String.raw`|[^\s${MARKS}]{0,128}@(?:[^\s/?#${MARKS}]*@)?))`,
  "g",
);

const sharePath = (slash: string) =>
  `${slash}(?:api${slash}v1${slash}pages${slash}shared|p)${slash}`;
// Where a share path starts: after an origin, a locale, or any character a path segment cannot
// hold. A redaction counts as part of a segment.
const shareLink = (slash: string, origin: string) =>
  String.raw`(?:^|[^\w.~%/${MARKS}-]|${origin})(?:${slash}[a-z]{2}(?:-[a-z]{2,4})?)?${sharePath(slash)}`;
const SLASH = String.raw`\/`;
const ENCODED_SLASH = "%(?:25)*2F";
const ORIGIN = String.raw`:\/\/[^/\s?#${USER_MARK}]*`;
const ENCODED_ORIGIN = String.raw`%(?:25)*3A(?:${ENCODED_SLASH}){2}[^/\s?#%${MARKS}]*(?:%(?:25)*3A\d+)?`;
// A shared page's link is its only credential, in the API path and in the web page path, plain or
// percent-encoded. The lookbehind runs only after a link path matched and stops at the previous
// slash, plain or encoded like the path itself, so the scan stays linear.
const PAGE_SHARE_LINK = new RegExp(
  `(${sharePath(SLASH)}|${sharePath(ENCODED_SLASH)})` +
    `(?<=${shareLink(SLASH, ORIGIN)}|${shareLink(ENCODED_SLASH, ENCODED_ORIGIN)})` +
    String.raw`(?![${MARKS}])[^/?#&%\s"'<>()[\]{},;:\x60]+`,
  "gi",
);

// Consume a failed local-part candidate once instead of retrying at every dot or hyphen.
const EMAIL_CANDIDATE = new RegExp(
  String.raw`[A-Z0-9._%+${WORLD}-]+(?:@[A-Z0-9.${WORLD}-]+\.[A-Z${WORLD}]{2,})?`,
  "gi",
);

// A hyphenated key or a signed token may follow an underscore, but never a letter or digit:
// `task-1234` is a word.
const BARE_SECRET = /(?:(?:(?<![A-Za-z0-9])sk-|\bsk_)[A-Za-z0-9_-]{8,}|\b[ac]k_[A-Za-z0-9_-]+)\b/g;
// Consume failed JWT headers once; keys within a failed header still need redaction.
const BARE_SECRET_CANDIDATE = new RegExp(
  String.raw`${BARE_SECRET.source}|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)?\b`,
  "g",
);

const WINDOWS_PROFILE_PATH = new RegExp(WINDOWS_PROFILE, "gi");
const POSIX_PROFILE_PATH = new RegExp(POSIX_PROFILE, "g");

// The order is part of the contract. A value named by its key goes before anything matches its
// contents, credentials in a URL go before the address they would otherwise look like, and a
// shared link goes before the rules that would break up its origin. Every rule stops at an
// earlier redaction, so what a later rule removes never lets an earlier one match on a second pass.
export function redactSensitiveText(text: string): string {
  let redacted = text
    .replace(WRITTEN_MARKER, (marker) => (marker === REDACTED ? REDACTED_MARK : USER_MARK))
    .replace(
      INVALID_HEADER_VALUE,
      `Headers.append: $1${REDACTED_MARK}$1 is an invalid header value.`,
    );
  // Most lines name no secret and hold no address; skip the two rules that visit every word.
  if (SECRET_WORD.test(redacted)) {
    redacted = redacted.replace(
      KEYED_SECRET,
      (_match, key: string, keyQuote: string, separator: string, flag: string, valueQuote = "") =>
        flag
          ? `${flag}${REDACTED_MARK}`
          : keyQuote
            ? `${key}${keyQuote}${separator}${valueQuote}${REDACTED_MARK}${valueQuote}`
            : `${key}=${REDACTED_MARK}`,
    );
  }
  redacted = redacted
    .replace(BEARER, `Bearer ${REDACTED_MARK}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED_MARK}@`)
    .replace(PAGE_SHARE_LINK, `$1${REDACTED_MARK}`);
  if (redacted.includes("@")) {
    redacted = redacted.replace(EMAIL_CANDIDATE, (candidate) =>
      candidate.includes("@") ? REDACTED_MARK : candidate,
    );
  }
  return redacted
    .replace(BARE_SECRET_CANDIDATE, (candidate) =>
      candidate.startsWith("eyJ") && !candidate.includes(".")
        ? candidate.replace(BARE_SECRET, REDACTED_MARK)
        : REDACTED_MARK,
    )
    .replace(WINDOWS_PROFILE_PATH, USER_MARK)
    .replace(POSIX_PROFILE_PATH, `/${USER_MARK}`)
    .replace(MARK, (mark) => (mark === REDACTED_MARK ? REDACTED : USER));
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
