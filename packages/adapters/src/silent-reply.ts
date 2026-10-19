import type { MessageBlock } from "@rakazo/contracts";

/** Exact token a silent routine must emit as its entire final assistant reply. */
export const NO_RESPONSE = "NO_RESPONSE";

function textBlocksOf(
  blocks: readonly MessageBlock[],
): Array<Extract<MessageBlock, { kind: "text" }>> {
  return blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text",
  );
}

function joinedText(blocks: readonly MessageBlock[]): string {
  return textBlocksOf(blocks)
    .map((block) => block.text)
    .join("");
}

/**
 * The sentinel alone, once or repeated. Text segments of one turn are joined
 * with no separator, so a model that re-emits the sentinel after each tool
 * batch yields `NO_RESPONSENO_RESPONSE`; that is still a silent reply, not prose.
 */
const SENTINEL_ONLY = /^(?:NO_RESPONSE\s*)+$/;

/** True when trimmed text is only the silent-routine sentinel, once or repeated. Extra prose does not match. */
export function isExactNoResponse(text: string): boolean {
  return SENTINEL_ONLY.test(text.trim());
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const WHITESPACE = /\s/;

/**
 * Edge runs of the sentinel, glued or spaced. Each token must end at a word
 * boundary to count: a token that continues into an identifier such as
 * `NO_RESPONSE_POLICY` is a word, so the run stops at the last clean token
 * before it instead of being abandoned altogether.
 */
function proseRange(text: string): { start: number; end: number } {
  let cursor = text.length - text.trimStart().length;
  let start = 0;
  while (text.startsWith(NO_RESPONSE, cursor)) {
    cursor += NO_RESPONSE.length;
    if (!IDENTIFIER_CHAR.test(text[cursor] ?? "")) {
      while (cursor < text.length && WHITESPACE.test(text[cursor]!)) cursor++;
      start = cursor;
    } else if (!text.startsWith(NO_RESPONSE, cursor)) {
      break;
    }
  }
  // Scan backwards from the end so long whitespace cannot cause suffix backtracking.
  cursor = text.trimEnd().length;
  let end = text.length;
  while (cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor)) {
    cursor -= NO_RESPONSE.length;
    if (cursor <= start || !IDENTIFIER_CHAR.test(text[cursor - 1] ?? "")) {
      while (cursor > start && WHITESPACE.test(text[cursor - 1]!)) cursor--;
      end = cursor;
    } else if (!(cursor - NO_RESPONSE.length >= start && text.endsWith(NO_RESPONSE, cursor))) {
      break;
    }
  }
  return { start, end };
}

/**
 * Silent-reply stripper. If the trimmed final text is exactly `NO_RESPONSE`,
 * drop that text so the run can finish with no chat bubble. Sibling tool/step
 * blocks do not count as extra prose. Surrounding words keep the reply; only a
 * stray sentinel at the start or end of that prose is removed from it.
 */
export function stripNoResponseReply(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledTrimmed = assembled.trim();
  const blockText = joinedText(blocks).trim();
  const visible = assembledTrimmed || blockText;
  if (!isExactNoResponse(visible)) return withoutStraySentinelsAtEdges(assembled, blocks);
  // Fail closed: extra prose in either the assembled final or a text block keeps the reply.
  if (assembledTrimmed && blockText && !isExactNoResponse(blockText)) {
    return { assembled, blocks };
  }
  return {
    assembled: "",
    blocks: blocks.filter((block) => block.kind !== "text"),
  };
}

/** A reply with prose stays a reply; a sentinel misplaced at its edge is dropped from what the user sees. */
function withoutStraySentinelsAtEdges(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledRange = proseRange(assembled);
  const cleanedAssembled = assembled.slice(assembledRange.start, assembledRange.end);
  const blockText = joinedText(blocks);
  const { start, end } = proseRange(blockText);
  if (start === 0 && end === blockText.length) {
    return { assembled: cleanedAssembled, blocks };
  }

  let offset = 0;
  const cleanedBlocks = blocks.flatMap<MessageBlock>((block) => {
    if (block.kind !== "text") return [block];
    const blockStart = offset;
    offset += block.text.length;
    const text = block.text.slice(Math.max(0, start - blockStart), Math.max(0, end - blockStart));
    if (text === block.text) return [block];
    return text ? [{ ...block, text }] : [];
  });
  return { assembled: cleanedAssembled, blocks: cleanedBlocks };
}
