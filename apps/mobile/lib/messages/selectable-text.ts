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

type TableRow = { cells: string[]; wrapped: boolean };

/** Table cells, split on pipes that are neither escaped nor inside an inline code span. */
function tableRow(line: string): TableRow | null {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.includes("|")) return null;
  const leadingPipe = trimmed.startsWith("|");
  const cells: string[] = [];
  let cell = "";
  let fence = 0;
  for (let i = leadingPipe ? 1 : 0; i < trimmed.length; i++) {
    const char = trimmed[i] ?? "";
    if (char === "\\" && i + 1 < trimmed.length) {
      cell += char + trimmed[++i];
    } else if (char === "`") {
      let run = 1;
      while (trimmed[i + run] === "`") run++;
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
  if (cells.length === 0 && !leadingPipe) return null;
  const trailingPipe = cell === "" && cells.length > 0;
  if (!trailingPipe) cells.push(cell);
  return { cells, wrapped: leadingPipe && trailingPipe && trimmed.length > 2 };
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.every((cell) => DELIMITER_CELL.test(cell.trim()));
}

function convertTableCell(cell: string): string {
  const text = cell.trim();
  // A dash-only cell can look like a horizontal rule to the preview helper.
  return DELIMITER_CELL.test(text) ? text : convert(text);
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
  const source = markdown.split(/\r\n?|\n/);
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
    if (i === tableDelimiterAt) continue;

    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) inList = true;
    else if (!/^\s/.test(line)) inList = false;

    if (RULE.test(line)) {
      lines.push({ text: "", code: false });
      previousBlank = true;
      inTable = false;
      continue;
    }
    const startsBlock = bullet || numbered || /^ {0,3}(?:>|#{1,6}(?:\s|$))/.test(line);
    if (startsBlock) inTable = false;
    const row = startsBlock ? null : tableRow(line);
    // A table can have a body row without pipes, so only a new block ends it.
    if (row && !inTable) {
      const next = tableRow(source[i + 1] ?? "");
      if (next?.cells.length === row.cells.length && isDelimiterRow(next.cells)) {
        tableDelimiterAt = i + 1;
        inTable = true;
      }
    }

    previousBlank = false;
    if (bullet) {
      lines.push({ text: `${bullet[1]}• ${convert(bullet[2] ?? "")}`, code: false });
    } else if (numbered) {
      lines.push({ text: `${numbered[1]} ${convert(numbered[2] ?? "")}`, code: false });
    } else {
      const cells = row && (inTable || row.wrapped || isDelimiterRow(row.cells)) ? row.cells : null;
      lines.push({
        text: cells ? cells.map(convertTableCell).join(" | ") : convert(line),
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
