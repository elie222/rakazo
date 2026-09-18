const PAYLOAD_MARK = "\uE000";

/** Markdown source → a single plain line for previews and notifications. */
export function plainTextFromMarkdown(markdown: string): string {
  const payloads: string[] = [];
  const stash = (payload: string): string => {
    payloads.push(payload);
    return `${PAYLOAD_MARK}${payloads.length - 1}${PAYLOAD_MARK}`;
  };

  let text = takeFencedCode(markdown.replace(/\r\n/g, "\n"), stash);
  text = takeInlineCode(text, stash);
  text = takeLinks(text)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g, "$1")
    .replace(/<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, " ");
  text = text.replace(
    new RegExp(`${PAYLOAD_MARK}(\\d+)${PAYLOAD_MARK}`, "g"),
    (_match, index: string) => payloads[Number(index)] ?? "",
  );
  return text.replace(/\s+/g, " ").trim();
}

/** Strip Markdown first so truncation cannot land inside a marker. */
export function truncatedPlainText(markdown: string, maxChars: number): string {
  return plainTextFromMarkdown(markdown).slice(0, maxChars);
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
  let out = "";
  let i = 0;
  while (i < text.length) {
    const image = text.startsWith("![", i);
    if (image || text[i] === "[") {
      const open = image ? i + 1 : i;
      const labelEnd = matchBalanced(text, open, "[", "]");
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const destEnd = matchBalanced(text, labelEnd + 1, "(", ")");
        if (destEnd !== -1) {
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

function matchBalanced(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
