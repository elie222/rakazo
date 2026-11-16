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
  "passw(?:or)?d",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credential",
  "api[_-]?key",
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

// While the rules run, each marker is one character that no key, name or token can contain: a
// noncharacter, which valid text never holds. To a rule it is one more character of the text
// around it, so a marker never ends a match early and what follows one is still read.
const REDACTED_MARK = "\uFDD0";
const USER_MARK = "\uFDD1";
const MARKS = REDACTED_MARK + USER_MARK;
// The same two characters in the input are not markers, and become the replacement character.
const STRAY_MARK = "\uFFFD";
const WRITTEN_MARKER = new RegExp(String.raw`\[Redacted\]|\[user\]|[${MARKS}]`, "g");
const MARK = new RegExp(`[${MARKS}]`, "g");

// An unfinished quoted value consumes the rest of the text as well. The rule's own finished
// output is left alone, with the last word as it wrote it or as the address rule left it.
const INVALID_HEADER_VALUE = new RegExp(
  String.raw`Headers\.append: (\\?")(?!${REDACTED_MARK}\1 is an invalid header (?:value\.|${REDACTED_MARK}))[\s\S]*?(?:\1 is an invalid header value\.|$)`,
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

// A quote, plain or escaped. JSON nested in strings four deep puts fifteen backslashes before it.
const MAX_QUOTE_ESCAPES = 16;
const QUOTE = String.raw`\\{0,${MAX_QUOTE_ESCAPES}}["']`;
const SEPARATOR = String.raw`\s*(?::|=>?)\s*`;
// The text so far ends in a secret-named key, and in its separator. The start of the word is
// checked before the names in it, so a long word is read once.
const NAMED = String.raw`(?=[\w.-]*?(?:${SECRET_NAMES}|email))(?<![\w.-])[\w.-]+(?:${QUOTE})?`;
const AFTER_KEY = String.raw`${NAMED}\s*(?::|=>?)`;
// A run that ends before the next space would cut short the value of a secret-named key it meets,
// so it stops once it has taken that key and the key's value is read as a value: quoted, in
// brackets, or after a scheme.
const upToNextKey = (char: string) => `(?:(?<!${AFTER_KEY})${char})*`;
const REST = upToNextKey(String.raw`\S`);
// A quote straight after a secret-named key or flag opens that one's value rather than closing a
// string: the quotes are then not paired the way they read.
const NOT_OPENING = String.raw`(?<!(?=[\w.-]*?(?:${SECRET_NAMES}|email))(?<![\w.-])(?:--[\w-]+[ \t]+|[\w.-]+(?:${QUOTE})?${SEPARATOR})${QUOTE})`;
// A string stays on its line, so one that never closes is not read again from every line after.
const STRING = String.raw`"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'`;
// Quoted at any escaping depth; an escaped quote inside an escaped value has a backslash before it.
// An escaped quote closes on its own line and within this many characters. Without a bound,
// each key before an unclosed escaped quote would be read to the end of the text, which is
// quadratic in the number of such keys; a longer value is taken as unclosed, to its line's end.
const ESCAPED_VALUE_MAX = 1024;
const quoted = (name: string) =>
  String.raw`(?=(?<${name}>${QUOTE}))(?:["'](?:\\[\s\S]|(?!\k<${name}>)[^\\])*|\\{1,${MAX_QUOTE_ESCAPES}}["'][^\n]{0,${ESCAPED_VALUE_MAX}}?(?<!\\))\k<${name}>${NOT_OPENING}`;
// In a list or object a secret-named key stands in a string with its value after it, as JSON
// writes it. A bare one means the value is not taken as closed.
const ITEM = String.raw`(?:(?:${STRING})${NOT_OPENING}|(?!(?<![\w-])(?=[\w-]*?(?:${SECRET_NAMES})))[^\][{}"'])`;
// A list or object on one level.
const BRACKETED = String.raw`\[${ITEM}*\]|\{${ITEM}*\}`;
// A quote that never closes, or a nested list or object, takes the rest of its line.
const UNCLOSED = String.raw`${QUOTE}[^\n]*|[[{][^\n]*`;
const SCHEME = String.raw`(?:basic|bearer|digest|token)\s+`;
const CREDENTIAL = String.raw`(?:${SCHEME})?\S${REST}`;
// A header goes on after a comma or semicolon for as long as `name=value` parameters follow. A
// secret-named one may hold a scheme and its credential, and one that opens a quote it does not
// close, or a bracket, ends the header there and is read as a key of its own.
const PARAMETER_VALUE = String.raw`(?:"[^"\n]*")?(?:(?<=authorization[\w-]*=>?)[a-z][\w-]*[ \t]+|(?<=${AFTER_KEY})${SCHEME})?(?:(?!(?<=${AFTER_KEY})(?:${QUOTE}|[[{]))\S${REST})?`;
const PARAMETERS = String.raw`(?:(?<=[,;])[ \t]+[\w.-]+=>?${PARAMETER_VALUE})*`;
// After a quoted key the value ends where its field does, so the fields beside it stay.
const FIELD_REST = upToNextKey(String.raw`[^\s,}\]]`);
const value = (name: string) =>
  [
    `(?:(?<=["']${SEPARATOR})(?:${quoted(`${name}Field`)}`,
    String.raw`|(?:${BRACKETED}|(?!${QUOTE}|[[{])[^\s,}\]])${FIELD_REST}|${UNCLOSED})`,
    // Elsewhere what is glued to the closing quote goes too, and a profile path is one value
    // although the account name in it may hold spaces.
    `|(?:${quoted(`${name}Free`)}|${BRACKETED}|${WINDOWS_PROFILE}|${POSIX_PROFILE})${REST}|${UNCLOSED}`,
    // Whatever the scheme, its credential goes with it.
    String.raw`|(?:(?<=authorization[\w-]*${SEPARATOR})(?:[a-z][\w-]*[ \t]+)?\S${REST}`,
    String.raw`|(?<=cookie[\w-]*${SEPARATOR})${CREDENTIAL})${PARAMETERS}`,
    `|${CREDENTIAL})`,
  ].join("");
// A value that stopped at the next secret-named key, with its separator taken or still to come,
// takes the value that key names too, so no key goes without one.
const NEXT_VALUE = String.raw`(?:(?<=${AFTER_KEY})>?\s*|(?<=${NAMED})${SEPARATOR})(?=\S)`;
// Each further value runs on the way the first key's value does, so the whole run of values is
// read at once and ends where reading it again would end.
const values = (name: string, rest: string) =>
  `${value(name)}(?:${NEXT_VALUE}${value(`${name}Next`)}${rest})*`;
const KEY_START = String.raw`(?<![\w-])`;
// A quoted key may be dotted and follows the structured rule for addresses.
const QUOTED_KEY = String.raw`(?<=["'])(?=[\w.-]*?(?:${SECRET_NAMES}|email))[\w.-]+(?=${QUOTE})`;
// A bare key goes on through dotted parts only before `=`: `name.ext:` is a file and a line.
// Before a colon, a word that ends as an error's name does, or the last part of a file path, is
// not a key: `CredentialsProviderError: …` and `/etc/passwd: permission denied` are messages.
// Only a forward slash marks a path here: a backslash also starts an escape, and the `n` of an
// escaped line break sits right before a header's name (`\nAuthorization: …`).
const NOT_A_MESSAGE = String.raw`(?![\w-]*(?:Error|Exception|Warning)\s*:)(?!(?<=\/)[\w-]+\s*:)`;
const BARE_KEY = String.raw`${NOT_A_MESSAGE}(?=[\w-]*?(?:${SECRET_NAMES}))[\w-]+(?:(?:\.[\w-]+){1,4}(?=\s*=))?`;
// A flag starts its word.
const FLAG = String.raw`--(?=[\w-]*?(?:${SECRET_NAMES}))[\w-]+[ \t]+`;
// A value after a secret-named key: `key=value`, `"key": value`, `key => value` or `--key value`.
// Each key starts once, at the start of its word, and only a word that contains a secret name is
// tried as a key at all, so a long word is scanned once rather than once per name inside it or
// per form a key can take. Looking for the value's first character before reading it keeps a
// long run of spaces from being retried. The engine stops optimising a pattern longer than about
// twenty thousand characters and then runs it two to three times slower, which is why the parts
// above share their tails instead of spelling each alternative out.
const KEYED_SECRET = new RegExp(
  [
    String.raw`${KEY_START}(?=[\w-]*?(?:${SECRET_NAMES})|(?<=["'])[\w.-]*?(?:${SECRET_NAMES}|email))(?:`,
    `(?<key>${QUOTED_KEY}|${BARE_KEY})(?<keyQuote>${QUOTE})(?<separator>${SEPARATOR})`,
    String.raw`(?=\S)${values("quoted", FIELD_REST)}`,
    `|(?:(?<bareKey>${BARE_KEY})${SEPARATOR}|(?<flag>${FLAG})(?!-))`,
    // A header's parameters go on after the value of a secret-named one among them.
    String.raw`(?=\S)${values("bare", `${REST}${PARAMETERS}`)})`,
  ].join(""),
  "gi",
);
/** Exported for the test that keeps the pattern under the size at which the engine slows. */
export const KEYED_SECRET_PATTERN_LENGTH = KEYED_SECRET.source.length;
type KeyedGroups = Partial<
  Record<"key" | "keyQuote" | "separator" | "bareKey" | "flag" | "quotedField", string>
>;

const BEARER = /\bBearer\s+[^\s"',;&]+/gi;

const URL_END = String.raw`\s"'<>,;)\]}\\&/?#\x60`;
// What ends a URL in text whatever the URL holds; the other characters may be part of a password.
const URL_STOP = String.raw`\s"'<>\\\x60`;
// A password never runs into the next URL, so each one is scanned once however many share a line.
const urlRun = (stops: string) => String.raw`(?:(?!:\/\/)[^${stops}])`;
// The password in `scheme://user:password@host`, whatever characters it holds: up to the last `@`
// before the URL stops, even when that takes a path with an `@` in it. A password that holds a
// quote runs past it to the first `@`, for a short way only so the text after a URL without
// credentials stays. A number that ends where a URL or its sentence can is a port, unless an
// `@` follows before the host could have ended, which makes it the start of a password; a letter
// before a path is a drive, and a colon that opens a URL this rule has taken the credentials out
// of opens that URL still.
const URL_CREDENTIALS = new RegExp(
  String.raw`(:\/\/(?![A-Za-z]:[\\/])[^:[${URL_END}]*:)(?!\d{1,5}[.:!]*(?:[/?#${URL_STOP}]|$|[,;)\]}&](?![^/?#${URL_STOP}]*@)))` +
    String.raw`(?!\/\/[^:[${URL_END}]*:${REDACTED_MARK}@)` +
    `(?:${urlRun(URL_STOP)}*@|${urlRun("\\s")}{0,128}?@)`,
  "g",
);

const sharePath = (slash: string) =>
  `${slash}(?:api${slash}v1${slash}pages${slash}shared|p)${slash}`;
const SLASH = String.raw`\/`;
const ENCODED_SLASH = "%(?:25)*2F";
// A token may hold percent-encoded characters; only an encoded `/`, `?`, `#` or `&` ends it, as
// the plain one does.
const SHARE_TOKEN = String.raw`(?:[^/?#&%\s"'<>()[\]{},;:\x60]|%(?!(?:25)*(?:2F|3F|23|26))[0-9A-F]{2})+`;
// Where a share path starts: after an origin, a locale, any character a path segment cannot hold,
// or the token of the link before it, so links in a row all go at once.
const shareLink = (slash: string, origin: string) =>
  String.raw`(?:^|[^\w.~%/-]|${origin}|(?:${sharePath(SLASH)}|${sharePath(ENCODED_SLASH)})${SHARE_TOKEN})(?:${slash}[a-z]{2}(?:-[a-z]{2,4})?)?${sharePath(slash)}`;
const ORIGIN = String.raw`:\/\/[^/\s?#]*`;
const ENCODED_ORIGIN = String.raw`%(?:25)*3A(?:${ENCODED_SLASH}){2}[^/\s?#%]*(?:%(?:25)*3A\d+)?`;
// A shared page's link is its only credential, in the API path and in the web page path, plain or
// percent-encoded. The lookbehind runs only after a link path matched and stops at the previous
// slash, plain or encoded like the path itself, so the scan stays linear.
const PAGE_SHARE_LINK = new RegExp(
  `(${sharePath(SLASH)}|${sharePath(ENCODED_SLASH)})` +
    `(?<=${shareLink(SLASH, ORIGIN)}|${shareLink(ENCODED_SLASH, ENCODED_ORIGIN)})` +
    SHARE_TOKEN,
  "gi",
);

const EMAIL_LOCAL = `[A-Z0-9._%+${WORLD}-]`;
const EMAIL = new RegExp(String.raw`${EMAIL_LOCAL}+@[A-Z0-9.${WORLD}-]+\.[A-Z${WORLD}]{2,}`, "gi");
// A local part starts where its run of characters does, or straight after the address before it,
// so a run that is no address is read once instead of again from every dot or hyphen in it.
const EMAILS = new RegExp(`(?<!${EMAIL_LOCAL})(?:${EMAIL.source})+`, "gi");

// A hyphenated key or a signed token may follow an underscore, but never a letter or digit:
// `task-1234` is a word. Each candidate is taken whole, in one step, and `redactBareKey` decides
// what in it is a key, so a long run of prefixes is read once.
const BARE_SECRET = /(?:(?:(?<![A-Za-z0-9])sk-|\bsk_)[A-Za-z0-9_-]{8,}|\b[ac]k_[A-Za-z0-9_-]+)\b/g;
const SHORT_PREFIX = /^[acs]k_/;
const SHORT_KEY = /^[acs]k_[A-Za-z0-9]+$/;
/**
 * After a two-letter prefix, underscores and hyphens belong to a key only when a digit or a
 * capital shows it is random: `ck_orders_amount_positive` and `sk_customer_id` are names. Without one, each
 * hyphen-separated part is a key only when it is a prefix and one run of letters.
 */
function redactBareKey(candidate: string): string {
  const tail = candidate.slice(3);
  if (!SHORT_PREFIX.test(candidate) || /[A-Z0-9]/.test(tail) || !/[_-]/.test(tail))
    return REDACTED_MARK;
  return candidate
    .split("-")
    .map((part) => (SHORT_KEY.test(part) ? REDACTED_MARK : part))
    .join("-");
}
// Consume failed JWT headers once; keys within a failed header still need redaction.
const BARE_SECRET_CANDIDATE = new RegExp(
  String.raw`${BARE_SECRET.source}|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)?\b`,
  "g",
);

const WINDOWS_PROFILE_PATH = new RegExp(WINDOWS_PROFILE, "gi");
const POSIX_PROFILE_PATH = new RegExp(POSIX_PROFILE, "g");

type Rule = (text: string) => string;
// The order is part of the contract. A value named by its key goes before anything matches its
// contents, credentials in a URL go before the address they would otherwise look like, and a
// shared link goes before the rules that would break up its origin.
const RULES: Rule[] = [
  (text) =>
    text.replace(
      INVALID_HEADER_VALUE,
      `Headers.append: $1${REDACTED_MARK}$1 is an invalid header value.`,
    ),
  // Most lines name no secret and hold no address; skip the two rules that visit every word.
  (text) =>
    SECRET_WORD.test(text)
      ? text.replace(KEYED_SECRET, (...match) => {
          const {
            key,
            keyQuote,
            separator,
            bareKey,
            flag,
            quotedField = "",
          } = match.at(-1) as KeyedGroups;
          return flag
            ? `${flag}${REDACTED_MARK}`
            : bareKey
              ? `${bareKey}=${REDACTED_MARK}`
              : `${key}${keyQuote}${separator}${quotedField}${REDACTED_MARK}${quotedField}`;
        })
      : text,
  (text) => text.replace(BEARER, `Bearer ${REDACTED_MARK}`),
  (text) => text.replace(URL_CREDENTIALS, `$1${REDACTED_MARK}@`),
  (text) => text.replace(PAGE_SHARE_LINK, `$1${REDACTED_MARK}`),
  (text) =>
    text.includes("@")
      ? text.replace(EMAILS, (addresses) =>
          REDACTED_MARK.repeat(addresses.match(EMAIL)?.length ?? 1),
        )
      : text,
  (text) =>
    text.replace(BARE_SECRET_CANDIDATE, (candidate) =>
      candidate.startsWith("eyJ")
        ? candidate.includes(".")
          ? REDACTED_MARK
          : candidate.replace(BARE_SECRET, redactBareKey)
        : redactBareKey(candidate),
    ),
  (text) => text.replace(WINDOWS_PROFILE_PATH, USER_MARK),
  (text) => text.replace(POSIX_PROFILE_PATH, `/${USER_MARK}`),
];
// A redaction can complete a shape an earlier rule looks for, so the rules repeat until a whole
// round changes nothing: the result is then what redacting it again would give. A line with
// nothing to redact takes one round. Text that is still changing after this many rounds is
// returned as it stands.
const MAX_ROUNDS = 8;

export function redactSensitiveText(text: string): string {
  let redacted = text.replace(WRITTEN_MARKER, (marker) =>
    marker === REDACTED ? REDACTED_MARK : marker === USER ? USER_MARK : STRAY_MARK,
  );
  let settled = 0;
  for (let step = 0; settled < RULES.length && step < RULES.length * MAX_ROUNDS; step++) {
    const next = RULES[step % RULES.length]!(redacted);
    settled = next === redacted ? settled + 1 : 0;
    redacted = next;
  }
  return redacted.replace(MARK, (mark) => (mark === REDACTED_MARK ? REDACTED : USER));
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
