const PAYLOAD_MARK = "\uE000";

/** Markdown source → a single plain line for previews and notifications. */
export function plainTextFromMarkdown(markdown: string): string {
  const payloads: string[] = [];
  const source = markdown.replace(/\r\n/g, "\n");
  const mark = unusedMark(source);
  const payloadPattern = new RegExp(`${mark}(\\d+)${mark}`, "g");
  const restore = (text: string): string =>
    text.replace(payloadPattern, (_match, index: string) => payloads[Number(index)] ?? "");
  const stash = (payload: string): string => {
    payloads.push(payload);
    return `${mark}${payloads.length - 1}${mark}`;
  };

  let text = takeFencedCode(source, stash);
  text = takeInlineCode(text, stash);
  text = takeEscapes(text, stash);
  // Autolinks may contain stashed escapes; flatten only those literal payloads.
  text = takeLinks(text)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, (_match, url: string) =>
      stash(restore(url)),
    )
    .replace(/<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/g, (_match, email: string) => stash(restore(email)));
  text = stripUnderscoreEmphasis(stripHtmlTags(text))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/(\*\*)(.*?)\1/g, "$2")
    .replace(/(\*)([^*\n]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");
  text = restore(text);
  return text.replace(/\s+/g, " ").trim();
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

function unusedMark(text: string): string {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === PAYLOAD_MARK) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return PAYLOAD_MARK.repeat(longest + 1);
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
