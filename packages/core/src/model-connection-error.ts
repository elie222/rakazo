import { redactSecrets } from "./events.js";

const MARKER = "•••";

/** Shorter values, such as a local server's placeholder key, also appear in ordinary text. */
const MIN_KNOWN_SECRET_LENGTH = 8;

const CREDENTIAL_NAME =
  "(?:api|access|auth|private|subscription)[ _-]?key|secret|token|password|passwd|authorization|credential";
const NAME_QUOTE = "(?:\\\\{0,3}[\"'`])?";

// A name matches from its credential word on, so a prefix such as `MY_` or `x-` costs no
// scan, and each repeat is bounded or runs once per match: the search stays linear in the length
// of the text.
const NAMED_START = `(?:${CREDENTIAL_NAME}|(?<=[?&])key(?==))[A-Za-z0-9_-]{0,40}${NAME_QUOTE}([ \\t][A-Za-z]+)?${NAME_QUOTE}\\s*[:=](?!\\/\\/)\\s*`;
const NEXT_NAME = new RegExp(NAMED_START, "gi");

// Every alternative ends where a credential starts.
const CREDENTIAL_START = new RegExp(
  [
    NAMED_START,
    "\\b(?:bearer|basic)([ \\t]+)",
    ":\\/\\/(?=([^\\s/?#@]*)@)",
    "\\b(sk-)(?=[A-Za-z0-9_-]{8})",
  ].join("|"),
  "gi",
);

const QUOTE = /(\\*)(["'`])/y;
// An unquoted value ends at a quote, so one inside a JSON string leaves the string closed.
const BARE_VALUE = /[^\s"'`]+/y;
const QUERY_VALUE = /[^\s"'`&#]+/y;
const BARE_KEY = /[A-Za-z0-9_.~+/=*-]+/y;
const SEPARATOR = /\s*[:=]\s*/y;
const ONLY_OPENING_BRACKETS = /^[{[]+$/;
const AUTH_SCHEME = /[A-Za-z]{2,10}[ \t]+/y;
/** Shorter words after an unknown scheme are status codes and prose, not credentials. */
const MIN_SCHEME_CREDENTIAL_LENGTH = 8;
const PLAIN_WORD = /^(?:[A-Za-z][a-z]*|[A-Z]+)$/;
const CLOSING_PUNCTUATION = new Set(".,;:)]}>\\");
const MAX_CLOSING_PUNCTUATION = 3;
const NAME_PREFIX = /[A-Za-z0-9_.-]/;
const MAX_NAME_PREFIX_LENGTH = 64;

/** The secret is `[start, end)`; the search for the next one goes on at `resume`. */
type Span = { start: number; end: number; resume: number };

function matchAt(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

/** An unfinished quote hides the rest of its line, since nothing marks where the secret stops. */
function quotedSpan(text: string, at: number): Span | undefined {
  QUOTE.lastIndex = at;
  const open = QUOTE.exec(text);
  if (!open) return undefined;
  const depth = open[1]!.length;
  const quote = open[2]!;
  const start = at + open[0].length;
  let slashes = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === "\n" || char === "\r") return { start, end: index, resume: index };
    // A quote closes on the escaping that opened it; each backslash inside the value doubles
    // that escaping, so a quote inside it never lands on the same count.
    if (char === quote && slashes % (2 * (depth + 1)) === depth) {
      return { start, end: index - depth, resume: index + 1 };
    }
    slashes = 0;
  }
  return { start, end: text.length, resume: text.length };
}

/** Where the `?` or `&` is that makes the name at `nameAt` a URL query parameter. */
function queryMark(text: string, nameAt: number, floor = 0): number | undefined {
  let index = nameAt - 1;
  const first = Math.max(floor, nameAt - MAX_NAME_PREFIX_LENGTH);
  while (index >= first && NAME_PREFIX.test(text[index]!)) index -= 1;
  return index >= floor && (text[index] === "?" || text[index] === "&") ? index : undefined;
}

/** The search that found the next name, kept so that each stretch of text is searched once. */
let nameSearch: { from: number; found: number | undefined } = { from: 0, found: -1 };

function nextNameAt(text: string, at: number): number | undefined {
  if (at < nameSearch.from || (nameSearch.found !== undefined && at > nameSearch.found)) {
    NEXT_NAME.lastIndex = at;
    nameSearch = { from: at, found: NEXT_NAME.exec(text)?.index };
  }
  return nameSearch.found;
}

/**
 * An unquoted value runs to the next space or quote, or to the name of the next credential when
 * it ran into one (`a,password="b c"`, `credentials: api_key = "b c"`), which is then read in
 * turn. Sentence and bracket punctuation at its end belongs to the message.
 */
function bareSpan(text: string, at: number, pattern: RegExp): Span | undefined {
  const name = nextNameAt(text, at);
  // A query parameter keeps its `?` or `&`, which is what marks it as one.
  const limit = name === undefined ? text.length : (queryMark(text, name, at) ?? name);
  const token = matchAt(pattern, text.slice(at, limit), 0);
  if (!token || ONLY_OPENING_BRACKETS.test(token)) return undefined;
  let end = at + token.length;
  const least = Math.max(at, end - MAX_CLOSING_PUNCTUATION);
  while (end > least && CLOSING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
  return end > at ? { start: at, end, resume: end } : undefined;
}

function readsAsProse(text: string, span: Span): boolean {
  let end = span.end;
  while (end > span.start && CLOSING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
  return PLAIN_WORD.test(text.slice(span.start, end));
}

/**
 * The secret a value holds, quoted or not. Where the wording reads as a sentence
 * (`Bearer …`, `invalid_api_key: …`, `API key provided: …`), a plain word is left alone as prose.
 */
function valueSpan(
  text: string,
  at: number,
  options: { bare?: RegExp; proseAllowed?: boolean } = {},
): Span | undefined {
  let { proseAllowed } = options;
  let valueAt = at;
  for (let quoted = quotedSpan(text, valueAt); quoted; quoted = quotedSpan(text, valueAt)) {
    const separator = matchAt(SEPARATOR, text, quoted.resume);
    if (separator === undefined) return quoted;
    // A quoted string before a separator is the name of the value after it.
    valueAt = quoted.resume + separator.length;
    proseAllowed = /:\s/.test(separator);
  }
  const bare = bareSpan(text, valueAt, options.bare ?? BARE_VALUE);
  if (bare && !(proseAllowed && readsAsProse(text, bare))) return bare;
  return valueAt > at ? { start: valueAt, end: valueAt, resume: valueAt } : undefined;
}

/** `Authorization: Basic …` carries its credential after the scheme. */
function schemeLedSpan(text: string, at: number): Span | undefined {
  const scheme = matchAt(AUTH_SCHEME, text, at);
  const credential = scheme && valueSpan(text, at + scheme.length, { proseAllowed: true });
  if (!credential || credential.end - credential.start < MIN_SCHEME_CREDENTIAL_LENGTH) {
    return undefined;
  }
  return { start: at, end: credential.end, resume: credential.resume };
}

function assignedSpan(text: string, at: number, query: boolean, proseAllowed: boolean) {
  if (query) return valueSpan(text, at, { bare: QUERY_VALUE, proseAllowed });
  return schemeLedSpan(text, at) ?? valueSpan(text, at, { proseAllowed });
}

function userinfoSpan(at: number, userinfo: string): Span {
  const end = at + userinfo.length;
  return { start: at + userinfo.indexOf(":") + 1, end, resume: end };
}

function redactCredentialShapes(text: string): string {
  let output = "";
  let offset = 0;
  nameSearch = { from: 0, found: -1 };
  CREDENTIAL_START.lastIndex = 0;
  for (let match = CREDENTIAL_START.exec(text); match; match = CREDENTIAL_START.exec(text)) {
    const at = CREDENTIAL_START.lastIndex;
    const [found, wordBeforeSeparator, schemeGap, userinfo, bareKey] = match;
    const span = bareKey
      ? bareSpan(text, match.index, BARE_KEY)
      : userinfo !== undefined
        ? userinfoSpan(at, userinfo)
        : schemeGap
          ? valueSpan(text, at, { proseAllowed: true })
          : assignedSpan(
              text,
              at,
              // `?access_token=` and `&key=` end their value at the next parameter.
              found.endsWith("=") && queryMark(text, match.index) !== undefined,
              wordBeforeSeparator !== undefined || /:\s+$/.test(found),
            );
    if (!span) continue;
    CREDENTIAL_START.lastIndex = Math.max(at, span.resume);
    if (span.end <= span.start) continue;
    output += text.slice(offset, span.start) + MARKER;
    offset = span.end;
  }
  return output + text.slice(offset);
}

/** The values as entered, and as a URL or a JSON string would carry them. */
function knownSecretForms(secrets: ReadonlyArray<string | null | undefined>): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < MIN_KNOWN_SECRET_LENGTH) continue;
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    try {
      const encoded = encodeURIComponent(value);
      forms.add(encoded);
      forms.add(encoded.replaceAll("%20", "+"));
    } catch {
      // A lone surrogate has no URL encoding.
    }
  }
  return [...forms];
}

/** The credentials a model connection form holds, for `sanitizeModelConnectionError`. */
export function modelConnectionFormSecrets(form: {
  apiKey: string;
  headerRows: ReadonlyArray<{ value: string }> | null;
}): string[] {
  return [form.apiKey, ...(form.headerRows ?? []).map((row) => row.value)];
}

/**
 * Hides credentials in a model connection error before it is shown or sent to a client.
 * `knownSecrets` are the credentials the connection was tried with: every occurrence of them is
 * hidden wherever it appears, then the shapes a credential takes in provider errors are hidden
 * too, for the ones the caller does not know.
 */
export function sanitizeModelConnectionError(
  raw: string,
  knownSecrets: ReadonlyArray<string | null | undefined> = [],
): string {
  return redactCredentialShapes(redactSecrets(raw.trim(), knownSecretForms(knownSecrets), MARKER));
}
