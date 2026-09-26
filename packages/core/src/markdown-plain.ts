const PAYLOAD_MARK = "\uE000";

/** A preview collapses to one line; bounding the input bounds stash tokens. */
const MAX_PREVIEW_SOURCE = 4_096;
/** Beyond the cap a payload degrades to its raw text instead of a token. */
const MAX_STASHED_PAYLOADS = 256;

/** Markdown source → a single plain line for previews and notifications. */
export function plainTextFromMarkdown(markdown: string): string {
  const payloads: string[] = [];
  const source = markdown.replace(/\r\n/g, "\n").slice(0, MAX_PREVIEW_SOURCE);
  const payloadPattern = new RegExp(`${PAYLOAD_MARK}(\\d+)${PAYLOAD_MARK}`, "g");
  // Restored payload text is never rescanned — literal marks that come back
  // out of a payload cannot form phantom tokens. Payloads only ever contain
  // earlier tokens, so the recursion is bounded by the payload count.
  const restore = (text: string): string =>
    text.replace(payloadPattern, (_match, index: string) => restore(payloads[Number(index)] ?? ""));
  // Fixed one-char tokens: literal mark characters are stashed first so tokens
  // never collide, and token length stays constant regardless of input — an
  // adversarial reply cannot inflate the intermediate string.
  const stash = (payload: string): string => {
    if (payloads.length >= MAX_STASHED_PAYLOADS) return payload;
    payloads.push(payload);
    return `${PAYLOAD_MARK}${payloads.length - 1}${PAYLOAD_MARK}`;
  };

  let text = source.replaceAll(PAYLOAD_MARK, stash(PAYLOAD_MARK));
  text = takeFencedCode(text, stash);
  text = takeInlineCode(text, stash);
  text = takeEscapes(text, stash);
  // Autolinks may contain stashed escapes; flatten only those literal payloads.
  text = takeLinks(text)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, (_match, url: string) =>
      stash(restore(url)),
    )
    .replace(/<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/g, (_match, email: string) => stash(restore(email)));
  text = stripUnderscoreEmphasis(stripHtmlTags(text));
  // Table rows keep only their cells; a separator row is pure syntax.
  // flattenTableRows also strips heading/list/quote/break markers per line so
  // it can see them: a marked line interrupts the table instead of becoming a
  // phantom row, while its stripped text still previews. Runs before the
  // emphasis strips so "| **a** |" still reads "a".
  text = flattenTableRows(text)
    .replace(/(\*\*)(.*?)\1/g, "$2")
    .replace(/(\*)([^*\n]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");
  return restore(text).replace(/\s+/g, " ").trim();
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

/** Every GFM delimiter cell needs at least one hyphen: `| : |` is content. */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/** Heading, quote, list and break markers; the line's own text survives.
 *  Mirrors Android: headings allow ≤3 leading spaces, `>` needs no space. */
function stripLineMarker(line: string): string {
  const stripped = line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "");
  return /^\s*[-*_]{3,}\s*$/.test(stripped) ? "" : stripped;
}

/** Row text → "a, b"; edge pipes only produce empty ends, which drop out. */
function tableCells(line: string): string {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * One line per table row ("a, b"). A separator line opens a table only when
 * the line above it held a pipe — that header may omit the outer pipes, and
 * lines after the separator are data rows even without them, until the first
 * no-pipe line ends the table. Only the first separator is syntax; later
 * dash-only rows are data. Pipe-wrapped lines still flatten leniently outside
 * tables so sloppy single rows preview cleanly. Lines carrying a block
 * marker (heading, quote, list, break) can never be table rows — they end the
 * table — but a quoted stand-alone row like `> | a |` still flattens.
 */
function flattenTableRows(text: string): string {
  const out: string[] = [];
  let inTable = false;
  let prevHadPipe = false;
  let prevFlattened = false;
  for (const rawLine of text.split("\n")) {
    const line = stripLineMarker(rawLine);
    if (line !== rawLine) {
      inTable = false;
      prevHadPipe = false;
      prevFlattened = false;
      out.push(TABLE_ROW.test(line) ? tableCells(line) : line);
      continue;
    }
    if (!line.includes("|")) {
      inTable = false;
      prevHadPipe = false;
      prevFlattened = false;
      out.push(line);
      continue;
    }
    if (inTable) {
      out.push(tableCells(line));
      prevHadPipe = true;
      prevFlattened = true;
      continue;
    }
    if (isTableSeparator(line)) {
      if (prevHadPipe) {
        inTable = true;
        // A header written without outer pipes was emitted raw; flatten it now.
        if (!prevFlattened) out[out.length - 1] = tableCells(out[out.length - 1] ?? "");
      }
      continue;
    }
    if (TABLE_ROW.test(line)) {
      out.push(tableCells(line));
      prevFlattened = true;
    } else {
      out.push(line);
      prevFlattened = false;
    }
    prevHadPipe = true;
  }
  return out.join("\n");
}

/** Pair delimiter runs once, without rescanning unmatched suffixes. */
function stripUnderscoreEmphasis(text: string): string {
  type Delimiter = { start: number; end: number; removed: number };
  const delimiters: Delimiter[] = [];
  const openers: Delimiter[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(/_+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (text.slice(previousEnd, start).includes("\n")) {
      openers.length = 0;
    }
    previousEnd = end;
    const delimiter = { start, end, removed: 0 };
    delimiters.push(delimiter);
    // Two UTF-16 units preserve astral letters when checking each adjacent code point.
    const before = text.slice(Math.max(0, start - 2), start);
    const after = text.slice(end, end + 2);
    const canClose = !/^[\p{L}\p{N}\p{M}]/u.test(after) && /\S$/u.test(before);
    let remaining = end - start;
    while (canClose && remaining > 0 && openers.length) {
      const opener = openers[openers.length - 1];
      if (!opener) break;
      const available = opener.end - opener.start - opener.removed;
      const paired = Math.min(available, remaining);
      opener.removed += paired;
      delimiter.removed += paired;
      remaining -= paired;
      if (paired === available) openers.pop();
    }
    if (remaining > 0 && !/[\p{L}\p{N}\p{M}]$/u.test(before) && /^\S/u.test(after)) {
      openers.push(delimiter);
    }
  }
  const parts: string[] = [];
  let from = 0;
  for (const delimiter of delimiters) {
    if (!delimiter.removed) continue;
    parts.push(text.slice(from, delimiter.start));
    parts.push("_".repeat(delimiter.end - delimiter.start - delimiter.removed));
    from = delimiter.end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Strip Markdown first so truncation cannot land inside a marker. */
export function truncatedPlainText(markdown: string, maxChars: number): string {
  const text = plainTextFromMarkdown(markdown);
  if (text.length <= maxChars) return text;
  const end =
    maxChars > 0 && (text.charCodeAt(maxChars - 1) & 0xfc00) === 0xd800 ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}

/** Matching `>` for a tag at `<`, ignoring `>` inside quoted attributes. */
function htmlTagClose(text: string, open: number): number {
  let quote: '"' | "'" | undefined;
  let gtInOpenQuote = -1;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        gtInOpenQuote = -1;
        continue;
      }
      if (ch === ">" && gtInOpenQuote === -1) gtInOpenQuote = i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  if (gtInOpenQuote !== -1) return gtInOpenQuote;
  // Unclosed quote with no `>`: consume the rest so attribute text cannot leak.
  return quote && text.length > open + 1 ? text.length - 1 : -1;
}

function stripHtmlTags(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const close = htmlTagClose(text, i);
      if (close !== -1) {
        out += " ";
        i = close + 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function takeEscapes(text: string, stash: (payload: string) => string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, ch: string) =>
    stash(ch),
  );
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function takeFencedCode(text: string, stash: (payload: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = line.match(OPEN_FENCE);
    const marker = open?.[1];
    if (!marker) {
      out.push(line);
      continue;
    }
    const fenceChar = marker[0];
    if (fenceChar === "`" && (open?.[2] ?? "").includes("`")) {
      out.push(line);
      continue;
    }
    const body: string[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j]?.match(OPEN_FENCE);
      if (
        close?.[1] &&
        close[1][0] === fenceChar &&
        close[1].length >= marker.length &&
        (close[2] ?? "").trim() === ""
      ) {
        closed = true;
        break;
      }
      body.push(lines[j] ?? "");
    }
    if (!closed) {
      out.push(line);
      continue;
    }
    out.push(stash(body.join("\n")));
    i = j;
  }
  return out.join("\n");
}

function takeInlineCode(text: string, stash: (payload: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n += 1;
    const close = findInlineCodeClose(text, i + n, n);
    if (close === -1) {
      out += text.slice(i, i + n);
      i += n;
      continue;
    }
    out += stash(text.slice(i + n, close));
    i = close + n;
  }
  return out;
}

function findInlineCodeClose(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let m = 0;
    while (text[i + m] === "`") m += 1;
    if (m === n) return i;
    i += m - 1;
  }
  return -1;
}

function takeLinks(text: string): string {
  const closeBracket = closerAt(text, "[", "]");
  const closeParen = closerAt(text, "(", ")");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const image = text.startsWith("![", i);
    if (image || text[i] === "[") {
      const open = image ? i + 1 : i;
      const labelEnd = closeBracket[open];
      if (labelEnd !== undefined && text[labelEnd + 1] === "(") {
        const destEnd = closeParen[labelEnd + 1];
        if (destEnd !== undefined) {
          out += text.slice(open + 1, labelEnd);
          i = destEnd + 1;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function closerAt(text: string, open: string, close: string): Array<number | undefined> {
  const closeAt: Array<number | undefined> = Array.from({ length: text.length });
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === open) stack.push(i);
    else if (text[i] === close) {
      const start = stack.pop();
      if (start !== undefined) closeAt[start] = i;
    }
  }
  return closeAt;
}
