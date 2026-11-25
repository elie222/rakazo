import type { MessageBlock } from "@rakazo/contracts";
import { consecutiveImageRun } from "@rakazo/contracts";
import { isInlineImageBlock } from "./inline-image";

export type InlineImageBlock = Extract<MessageBlock, { kind: "image" }>;

/** The blocks a bubble draws as attachments: pictures and files. */
export type AttachmentBlock = InlineImageBlock | Extract<MessageBlock, { kind: "file" }>;

export type AttachmentGroup =
  | { kind: "single"; attachment: AttachmentBlock; index: number }
  | { kind: "pictures"; pictures: InlineImageBlock[] };

/**
 * The message's attachments in order, with each run of consecutive inline pictures gathered into
 * one group so the bubble draws them as one stack. A lone picture stays single.
 */
export function attachmentGroups(blocks: readonly MessageBlock[]): AttachmentGroup[] {
  const groups: AttachmentGroup[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== "image" && block.kind !== "file") return;
    if (!isInlineImageBlock(block)) {
      groups.push({ kind: "single", attachment: block, index });
      return;
    }
    // The later pictures of a run are drawn with its first.
    const run = consecutiveImageRun(blocks, index, isInlineImageBlock);
    if (!run) return;
    groups.push(
      run.length > 1
        ? { kind: "pictures", pictures: run }
        : { kind: "single", attachment: block, index },
    );
  });
  return groups;
}
