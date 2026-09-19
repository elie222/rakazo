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

/** True when trimmed text is exactly the silent-routine sentinel. Extra prose does not match. */
export function isExactNoResponse(text: string): boolean {
  return text.trim() === NO_RESPONSE;
}

/**
 * Exact-only silent-reply stripper. If the trimmed final text is exactly
 * `NO_RESPONSE`, drop that text so the run can finish with no chat bubble.
 * Sibling tool/step blocks do not count as extra prose. Any surrounding
 * words leave the reply intact.
 */
export function stripNoResponseReply(
  assembled: string,
  blocks: MessageBlock[],
): { assembled: string; blocks: MessageBlock[] } {
  const assembledTrimmed = assembled.trim();
  const blockText = joinedText(blocks).trim();
  const visible = assembledTrimmed || blockText;
  if (!isExactNoResponse(visible)) return { assembled, blocks };
  // Fail closed: extra prose in either the assembled final or a text block keeps the reply.
  if (assembledTrimmed && blockText && !isExactNoResponse(blockText)) {
    return { assembled, blocks };
  }
  return {
    assembled: "",
    blocks: blocks.filter((block) => block.kind !== "text"),
  };
}
