import type { MessageBlock } from "@rakazo/contracts";
import { REPLY_QUOTE_MAX_LENGTH } from "@rakazo/contracts";
import { toText } from "hast-util-to-text";
import { toHast } from "mdast-util-to-hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const markdownParser = unified().use(remarkParse).use(remarkGfm);
/** Past this much source text in one message, quote derivation refuses to run. */
export const MAX_QUOTABLE_SOURCE_LENGTH = 100_000;

type NormalizedText = {
  text: string;
  starts: number[];
  ends: number[];
};

/** Render Markdown to the text exposed by the web renderer, without UI chrome. */
export function visibleTextFromMarkdown(markdown: string): string {
  const mdast = markdownParser.parse(markdown);
  return toText(toHast(mdast));
}

function normalizeWithOffsets(value: string): NormalizedText {
  const source = value.normalize("NFC");
  const starts: number[] = [];
  const ends: number[] = [];
  let text = "";
  let whitespaceStart: number | undefined;

  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      whitespaceStart ??= index;
      continue;
    }
    if (whitespaceStart !== undefined && text) {
      text += " ";
      starts.push(whitespaceStart);
      ends.push(index);
    }
    whitespaceStart = undefined;
    text += char;
    starts.push(index);
    ends.push(index + 1);
  }

  return { text, starts, ends };
}

function cleanVisibleExcerpt(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\r\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve an untrusted selected-text hint to an authoritative parent excerpt.
 * Only persisted text blocks are quotable; the format must match their renderer.
 * Punctuation and case stay significant.
 */
export function deriveMessageQuote(
  blocks: MessageBlock[],
  quoteHint: string,
  format: "markdown" | "plain-text",
): string | undefined {
  const hint = normalizeWithOffsets(quoteHint.trim().slice(0, REPLY_QUOTE_MAX_LENGTH)).text;
  if (!hint) return undefined;

  const textBlocks = blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
  let sourceLength = 0;
  for (const block of textBlocks) {
    sourceLength += block.text.length;
    if (sourceLength > MAX_QUOTABLE_SOURCE_LENGTH) return undefined;
  }

  for (const block of textBlocks) {
    const visible = (
      format === "markdown" ? visibleTextFromMarkdown(block.text) : block.text
    ).normalize("NFC");
    const canonical = normalizeWithOffsets(visible);
    const match = canonical.text.indexOf(hint);
    if (match < 0) continue;

    const start = canonical.starts[match];
    const end = canonical.ends[match + hint.length - 1];
    if (start === undefined || end === undefined) continue;
    const quote = cleanVisibleExcerpt(visible.slice(start, end));
    if (quote.length <= REPLY_QUOTE_MAX_LENGTH) return quote;
  }
  return undefined;
}
