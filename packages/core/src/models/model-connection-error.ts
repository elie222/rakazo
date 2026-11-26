import { redactedRanges } from "../messages/events.js";

const MARKER = "•••";

/**
 * A known credential is hidden everywhere it appears, so a shorter one cannot be: a one-character
 * header value would blank every occurrence of that character, and `key` or `401` every word and
 * status that holds it.
 */
const MIN_KNOWN_SECRET_LENGTH = 4;
/**
 * A known value this long is hidden wherever it appears, inside other text included. A shorter
 * one is hidden only where it stands alone, so a key of `local` leaves `localhost` readable.
 */
const MIN_HIDDEN_ANYWHERE_LENGTH = 8;

const CREDENTIAL_NAME =
  "(?:api|access|auth|private|subscription)[ _-]?key|secret|token|password|passwd|authorization|credential";
const NAME_QUOTE = "(?:\\\\{0,3}[\"'`])?";

// A name matches from its credential word on, so a prefix such as `MY_` or `x-` costs no
// scan, and each repeat is bounded or runs once per match: the search stays linear in the length
// of the text.
const NAMED_START = `(?:${CREDENTIAL_NAME}|(?<=[?&])key(?==))[A-Za-z0-9_-]{0,40}(?:\\[[A-Za-z0-9_-]{0,20}\\])?${NAME_QUOTE}([ \\t][A-Za-z]+)?${NAME_QUOTE}\\s*[:=](?!\\/\\/)\\s*`;
const NEXT_NAME = new RegExp(NAMED_START, "gi");
const NAME_HERE = new RegExp(NAMED_START, "iy");

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
const BARE_VALUE = /[^\s"'`]/;
const QUERY_VALUE = /[^\s"'`&#]/;
const BARE_KEY = /[A-Za-z0-9_.~+/=*-]/;
const SEPARATOR = /\s*[:=](?!\/\/)\s*/y;
const ONLY_OPENING_BRACKETS = /^[{[]+$/;
const ONLY_OPENING_PUNCTUATION = /^[\s{["'`\\]*$/;
const AUTH_SCHEME = /[A-Za-z]{2,10}[ \t]+/y;
const KNOWN_SCHEME = /^(?:bearer|basic|digest|negotiate|token)[ \t]+$/i;
/** Shorter words after an unknown scheme are status codes and prose, not credentials. */
const MIN_SCHEME_CREDENTIAL_LENGTH = 8;
const PLAIN_WORD = /^(?:[A-Za-z][a-z]*|[A-Z]+)$/;
const HEADER_OPENING = /([^\s"'`]*)([ \t]*)([^\s"'`]*)/y;
const AUTHORIZATION_HEADER = /^authorization(?![A-Za-z0-9_-])[^\r\n]*$/i;
const QUOTED_NAME = /["'`]\s*:\s*$/;
/** Longer than any credential object a provider error repeats. */
const MAX_NESTED_VALUE_LENGTH = 2000;
const CLOSING_PUNCTUATION = new Set(".,;:)]}>\\");
const MAX_CLOSING_PUNCTUATION = 3;
const CLOSES_PROSE = new Set([...CLOSING_PUNCTUATION, '"', "'", "`"]);
const SCHEME_LED_VALUE = /^[A-Za-z][A-Za-z0-9_-]*[ \t]+(\S+)$/;
// The marker counts, so a parameter stays one once a key in its name is hidden.
const NAME_PREFIX = /[A-Za-z0-9_.•-]/;
const MAX_NAME_PREFIX_LENGTH = 64;

/** The secret is `[start, end)`; the search for the next one goes on at `resume`. */
type Span = { start: number; end: number; resume: number };

function matchAt(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

/** An unfinished quote hides the rest of its line, since nothing marks where the secret stops. */
function quotedSpan(text: string, at: number, limit = text.length): Span | undefined {
  QUOTE.lastIndex = at;
  const open = QUOTE.exec(text);
  if (!open) return undefined;
  const depth = open[1]!.length;
  const quote = open[2]!;
  const start = at + open[0].length;
  let slashes = 0;
  for (let index = start; index < limit; index += 1) {
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
  const end = Math.max(start, limit);
  return { start, end, resume: end };
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

/** Where the next credential's name starts, which no value before it runs past. */
function nextNameLimit(text: string, at: number): number {
  const name = nextNameAt(text, at);
  // A query parameter keeps its `?` or `&`, which is what marks it as one.
  return name === undefined ? text.length : (queryMark(text, name, at) ?? name);
}

/**
 * An unquoted value runs to the next space or quote, or to the name of the next credential when
 * it ran into one (`a,password="b c"`, `credentials: api_key = "b c"`), which is then read in
 * turn. Sentence and bracket punctuation at its end belongs to the message.
 */
function bareSpan(text: string, at: number, valueChar: RegExp): Span | undefined {
  const limit = nextNameLimit(text, at);
  let end = at;
  while (end < limit && valueChar.test(text[end]!)) end += 1;
  if (end === at || ONLY_OPENING_BRACKETS.test(text.slice(at, end))) return undefined;
  const least = Math.max(at, end - MAX_CLOSING_PUNCTUATION);
  while (end > least && CLOSING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
  return end > at ? { start: at, end, resume: end } : undefined;
}

/** A plain word, with any punctuation or quote that closes the sentence around it. */
function readsAsProse(word: string): boolean {
  let end = word.length;
  while (end > 0 && CLOSES_PROSE.has(word[end - 1]!)) end -= 1;
  return PLAIN_WORD.test(word.slice(0, end));
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
    // A quoted string before a separator is the name of the value after it; when that name is a
    // credential's own, it is read in turn, by the rules for its name.
    const name = nextNameAt(text, valueAt);
    if (name !== undefined && name < quoted.resume) return undefined;
    valueAt = quoted.resume + separator.length;
    proseAllowed = /:\s/.test(separator);
  }
  const bare = bareSpan(text, valueAt, options.bare ?? BARE_VALUE);
  if (bare && !(proseAllowed && readsAsProse(text.slice(bare.start, bare.end)))) return bare;
  return valueAt > at ? { start: valueAt, end: valueAt, resume: valueAt } : undefined;
}

/** `Authorization: Basic …` carries its credential after the scheme. */
function schemeLedSpan(text: string, at: number): Span | undefined {
  const scheme = matchAt(AUTH_SCHEME, text, at);
  const credential = scheme && valueSpan(text, at + scheme.length, { proseAllowed: true });
  if (!credential) return undefined;
  if (credential.end - credential.start < MIN_SCHEME_CREDENTIAL_LENGTH) {
    // After a scheme everyone knows, a short second word is still the credential unless it
    // reads as a plain word (`Bearer token`).
    const word = text.slice(credential.start, credential.end);
    if (!KNOWN_SCHEME.test(scheme) || readsAsProse(word)) return undefined;
  }
  return { start: at, end: credential.end, resume: credential.resume };
}

/** Where the line holding `from` ends, looking no further than `limit`. */
function lineEnd(text: string, from: number, limit = text.length): number {
  let end = from;
  while (end < limit && text[end] !== "\n" && text[end] !== "\r") end += 1;
  return end;
}

/**
 * An `Authorization` header's whole value is its credential, whatever scheme it opens with: to
 * its closing quote, or else to the end of its line. The credential is the first word or, after
 * a scheme, the second: when those are plain words (`Authorization: Bearer token is missing`),
 * the value is prose.
 */
function headerSpan(text: string, at: number): Span | undefined {
  const quoted = quotedSpan(text, at);
  if (quoted) return quoted;
  HEADER_OPENING.lastIndex = at;
  const [opening, first, gap, second] = HEADER_OPENING.exec(text) ?? [];
  if (!opening || !first) return undefined;
  const after = at + opening.length;
  // After a gap, a second word that is missing before the line ends is one that opens a quote.
  const lone = !second && (!gap || lineEnd(text, after, after + 1) === after);
  if (readsAsProse(first) && (lone || readsAsProse(second ?? ""))) return undefined;
  const resume = lineEnd(text, after);
  let end = resume;
  while (end > at && /\s/.test(text[end - 1]!)) end -= 1;
  const least = Math.max(at, end - MAX_CLOSING_PUNCTUATION);
  while (end > least && CLOSING_PUNCTUATION.has(text[end - 1]!)) end -= 1;
  return { start: at, end, resume };
}

/**
 * A credential that is an object or array (`api_key={"value":"…"}`) is hidden to the bracket that
 * closes it, not counting brackets inside its strings. The search for that bracket stops at the
 * name of the next credential, which is read in turn; a value that has not closed by then, or
 * within reach, is hidden to there or to the end of its line.
 */
function nestedSpan(text: string, at: number): Span | undefined {
  if (text[at] !== "{" && text[at] !== "[") return undefined;
  const limit = nextNameLimit(text, at);
  // To its closing bracket even past a credential name inside it: a field beside that one
  // belongs to the same credential.
  const reach = Math.min(text.length, at + MAX_NESTED_VALUE_LENGTH);
  let depth = 0;
  let index = at;
  while (index < reach) {
    const char = text[index]!;
    if (char === "\\" || char === '"' || char === "'" || char === "`") {
      const string = quotedSpan(text, index, reach);
      if (string) index = string.resume;
      else while (text[index] === "\\") index += 1;
      continue;
    }
    index += 1;
    if (char === "{" || char === "[") depth += 1;
    if (char !== "}" && char !== "]") continue;
    depth -= 1;
    if (depth > 0) continue;
    // What follows the bracket unbroken (`[ab]cd`) is more of the same unquoted value.
    const end = bareSpan(text, index, BARE_VALUE)?.end ?? index;
    return { start: at, end, resume: end };
  }
  let end = lineEnd(text, at, limit);
  while (end > at && /\s/.test(text[end - 1]!)) end -= 1;
  // Only the punctuation that opens the next credential's own field: nothing to hide here.
  if (ONLY_OPENING_PUNCTUATION.test(text.slice(at, end))) return undefined;
  return { start: at, end, resume: end };
}

type AssignedName = {
  /** `?access_token=` and `&key=` end their value at the next parameter. */
  query: boolean;
  header: boolean;
  /** Written as a field (`api_key=`, `"api_key": `), not as the wording of a sentence. */
  field: boolean;
  proseAllowed: boolean;
};

function assignedSpan(text: string, at: number, name: AssignedName): Span | undefined {
  const { proseAllowed } = name;
  if (name.query) return valueSpan(text, at, { bare: QUERY_VALUE, proseAllowed });
  if (name.header) return headerSpan(text, at);
  return (
    (name.field ? nestedSpan(text, at) : undefined) ??
    schemeLedSpan(text, at) ??
    valueSpan(text, at, { proseAllowed })
  );
}

function assignedName(
  text: string,
  nameAt: number,
  found: string,
  wordBeforeSeparator: string | undefined,
): AssignedName {
  const proseAllowed = wordBeforeSeparator !== undefined || /:\s+$/.test(found);
  return {
    query: found.endsWith("=") && queryMark(text, nameAt) !== undefined,
    header: wordBeforeSeparator === undefined && AUTHORIZATION_HEADER.test(found),
    field: !proseAllowed || QUOTED_NAME.test(found),
    proseAllowed,
  };
}

/** The user part of a URL, name and password both: a key is often sent as the name. */
function userinfoSpan(at: number, userinfo: string): Span {
  const end = at + userinfo.length;
  return { start: at, end, resume: end };
}

function redactCredentialShapes(text: string): string {
  let output = "";
  let offset = 0;
  nameSearch = { from: 0, found: -1 };
  CREDENTIAL_START.lastIndex = 0;
  for (let match = CREDENTIAL_START.exec(text); match; match = CREDENTIAL_START.exec(text)) {
    const at = CREDENTIAL_START.lastIndex;
    const [found, wordBeforeSeparator, schemeGap, userinfo, bareKey] = match;
    if (wordBeforeSeparator !== undefined) {
      // In `credentials api_key=…` the word before the separator is the name, read by its rules.
      const wordAt = match.index + found.lastIndexOf(wordBeforeSeparator) + 1;
      NAME_HERE.lastIndex = wordAt;
      if (NAME_HERE.test(text)) {
        CREDENTIAL_START.lastIndex = wordAt;
        continue;
      }
    }
    const span = bareKey
      ? bareSpan(text, match.index, BARE_KEY)
      : userinfo !== undefined
        ? userinfoSpan(at, userinfo)
        : schemeGap
          ? valueSpan(text, at, { proseAllowed: true })
          : assignedSpan(text, at, assignedName(text, match.index, found, wordBeforeSeparator));
    if (!span) continue;
    CREDENTIAL_START.lastIndex = Math.max(at, span.resume);
    if (span.end <= span.start) continue;
    output += text.slice(offset, span.start) + MARKER;
    offset = span.end;
  }
  return output + text.slice(offset);
}

/** Keeps the length, so a place in the folded text is the same place in the original. */
function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/**
 * The values as entered, and as a URL or a JSON string would carry them. They are matched without
 * regard to letter case, so `%2f` hides what was encoded as `%2F`.
 */
function knownSecretForms(secrets: ReadonlyArray<string | null | undefined>) {
  const anywhere = new Set<string>();
  const alone = new Set<string>();
  for (const secret of secrets) {
    const entered = secret?.trim();
    if (!entered) continue;
    // A header value such as `Bearer abc1` is sent whole, and an error may repeat only its token.
    // A short token that is a plain word (`Bearer token`) would blank that word in every message.
    const token = SCHEME_LED_VALUE.exec(entered)?.[1];
    const tokenIsKnown =
      token && (token.length >= MIN_HIDDEN_ANYWHERE_LENGTH || !PLAIN_WORD.test(token));
    for (const value of [entered, tokenIsKnown ? token : undefined]) {
      if (!value || value.length < MIN_KNOWN_SECRET_LENGTH) continue;
      const forms = value.length < MIN_HIDDEN_ANYWHERE_LENGTH ? alone : anywhere;
      const json = JSON.stringify(value).slice(1, -1);
      forms.add(value).add(json).add(json.replaceAll("/", "\\/"));
      try {
        // Form encoding also escapes the marks `encodeURIComponent` leaves as they are.
        for (const encoded of [encodeURIComponent(value), strictlyEncoded(value)])
          forms.add(encoded).add(encoded.replaceAll("%20", "+"));
      } catch {
        // A lone surrogate has no URL encoding.
      }
    }
  }
  return { anywhere: [...anywhere].map(foldAsciiCase), alone: [...alone] };
}

function strictlyEncoded(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function redactKnownSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>) {
  const { anywhere, alone } = knownSecretForms(secrets);
  let output = "";
  let offset = 0;
  for (const [start, end] of redactedRanges(foldAsciiCase(text), anywhere)) {
    output += text.slice(offset, start) + MARKER;
    offset = end;
  }
  output += text.slice(offset);
  if (alone.length === 0) return output;
  // Longest first, so a value is not cut short by a shorter one it starts with.
  const standingAlone = new RegExp(
    `(?<![A-Za-z0-9])(?:${alone
      .sort((a, b) => b.length - a.length)
      .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?![A-Za-z0-9])`,
    "gi",
  );
  return output.replace(standingAlone, MARKER);
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
  return redactCredentialShapes(redactKnownSecrets(raw.trim(), knownSecrets));
}
