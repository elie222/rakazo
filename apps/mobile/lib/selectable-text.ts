import { plainTextFromMarkdown } from "@rakazo/core";

const FENCE = /^\s*(```|~~~)/;
const BULLET = /^(\s*)[-*+]\s+/;
const NUMBERED = /^(\s*\d+\.)\s+/;
// Table separators and horizontal rules are pure syntax.
const SYNTAX_ONLY = /^[\s|:-]*-[\s|:-]*$/;

/**
 * A bot reply as plain text that keeps its paragraphs, list items and code
 * lines, so it can be shown as one block and selected across paragraphs.
 * Each line goes through `plainTextFromMarkdown`, so markup is stripped the
 * same way as in previews; fenced code is kept verbatim.
 */
export function selectableTextFromMarkdown(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (SYNTAX_ONLY.test(line)) {
      out.push("");
      continue;
    }
    const prefix = line.match(BULLET)
      ? `${line.match(BULLET)?.[1]}• `
      : (line.match(NUMBERED)?.[0] ?? "");
    out.push(
      prefix
        ? `${prefix.replace(/\s+$/, " ")}${plainTextFromMarkdown(line.replace(BULLET, "").replace(NUMBERED, ""))}`
        : plainTextFromMarkdown(line),
    );
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
