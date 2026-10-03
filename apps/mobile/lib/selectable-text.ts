import { plainTextFromMarkdown } from "@rakazo/core";

/** A line longer than this is shown as written rather than converted. */
const LINE_LIMIT = 100_000;

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*\d+[.)])\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const DELIMITER_CELL = /^:?-+:?$/;
const INDENTED = /^(?: {4}|\t)/;

type Line = { text: string; code: boolean };

/** Table cells, split on pipes that are neither escaped nor inside an inline code span. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (trimmed.length < 3 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells: string[] = [];
  let cell = "";
  let fence = 0;
  const body = trimmed.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if (char === "\\" && i + 1 < body.length) {
      cell += char + body[++i];
    } else if (char === "`") {
      let run = 1;
      while (body[i + run] === "`") run++;
      cell += "`".repeat(run);
      i += run - 1;
      fence = fence === 0 ? run : fence === run ? 0 : fence;
    } else if (char === "|" && fence === 0) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** `| --- | :-: |`: every cell is hyphens with optional colons. Linear in the line. */
function isDelimiterRow(line: string): boolean {
  const cells = tableCells(line);
  return cells?.every((cell) => DELIMITER_CELL.test(cell.trim())) ?? false;
}

function convert(line: string): string {
  return line.length > LINE_LIMIT ? line : plainTextFromMarkdown(line, { maxSource: LINE_LIMIT });
}

/**
 * A bot reply as plain text that keeps its paragraphs, list items and code
 * lines, so it can be shown as one block and selected across paragraphs.
 * Inline markup is stripped the same way as in previews; fenced and indented
 * code is kept verbatim, and nothing is truncated.
 */
export function selectableTextFromMarkdown(markdown: string): string {
  const source = markdown.replace(/\r\n/g, "\n").split("\n");
  const lines: Line[] = [];
  let fence: { char: string; length: number } | null = null;
  let inList = false;
  let previousBlank = true;
  let previousCode = false;
  let tableDelimiterAt = -1;
  let inTable = false;

  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? "";

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (close?.[0] === fence.char && close.length >= fence.length) {
        fence = null;
      } else {
        lines.push({ text: line, code: true });
      }
      previousBlank = false;
      previousCode = true;
      continue;
    }

    const open = line.match(OPEN_FENCE);
    const marker = open?.[1];
    // A backtick fence's info string cannot contain a backtick.
    if (marker && !(marker[0] === "`" && (open?.[2] ?? "").includes("`"))) {
      fence = { char: marker[0] ?? "`", length: marker.length };
      inTable = false;
      previousBlank = false;
      previousCode = true;
      continue;
    }

    const blank = line.trim() === "";
    if (blank) {
      lines.push({ text: "", code: previousCode && INDENTED.test(source[i + 1] ?? "") });
      previousBlank = true;
      inTable = false;
      continue;
    }

    if (INDENTED.test(line) && !inList && (previousBlank || previousCode)) {
      lines.push({ text: line.replace(INDENTED, ""), code: true });
      inTable = false;
      previousBlank = false;
      previousCode = true;
      continue;
    }
    previousCode = false;

    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) inList = true;
    else if (!/^\s/.test(line)) inList = false;

    if (i === tableDelimiterAt) continue;
    if (RULE.test(line)) {
      lines.push({ text: "", code: false });
      previousBlank = true;
      continue;
    }
    // A table separator only follows a table's header row; `| - | - |` later in
    // the table, or anywhere else, is data.
    if (tableCells(line) === null) inTable = false;
    else if (!inTable && isDelimiterRow(source[i + 1] ?? "")) {
      tableDelimiterAt = i + 1;
      inTable = true;
    }

    previousBlank = false;
    if (bullet) {
      lines.push({ text: `${bullet[1]}• ${convert(bullet[2] ?? "")}`, code: false });
    } else if (numbered) {
      lines.push({ text: `${numbered[1]} ${convert(numbered[2] ?? "")}`, code: false });
    } else {
      // Cells are converted one by one: the preview helper reads a lone
      // `| - | - |` row as a separator and would drop it.
      const cells = tableCells(line);
      lines.push({
        text: cells ? cells.map((cell) => convert(cell.trim())).join(" | ") : convert(line),
        code: false,
      });
    }
  }

  // Collapse runs of blank lines outside code; blank lines in code are content.
  const out: Line[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (!line.code && line.text === "" && previous && !previous.code && previous.text === "") {
      continue;
    }
    out.push(line);
  }
  while (out[0] && !out[0].code && out[0].text === "") out.shift();
  while (out.length > 0 && !out[out.length - 1]?.code && out[out.length - 1]?.text === "")
    out.pop();
  return out.map((line) => line.text).join("\n");
}
