import type { MessageBlock } from "@rakazo/contracts";
import { isInlineImageBlock } from "./inline-image";

export type InlineImageBlock = Extract<MessageBlock, { kind: "image" }>;

/** The blocks a bubble draws as attachments: pictures and files. */
export type AttachmentBlock = InlineImageBlock | Extract<MessageBlock, { kind: "file" }>;

export type AttachmentGroup =
  | { kind: "single"; attachment: AttachmentBlock; index: number }
  | { kind: "pictures"; pictures: InlineImageBlock[] };

/**
 * The message's attachments in order, with consecutive pictures gathered into one group so the
 * bubble draws them as one stack instead of one under another.
 */
export function attachmentGroups(attachments: AttachmentBlock[]): AttachmentGroup[] {
  const groups: AttachmentGroup[] = [];
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.kind === "image" && isInlineImageBlock(attachment)) {
      const previous = attachments[index - 1];
      if (previous && isInlineImageBlock(previous)) continue;
      const pictures: InlineImageBlock[] = [];
      for (const next of attachments.slice(index)) {
        if (next.kind !== "image" || !isInlineImageBlock(next)) break;
        pictures.push(next);
      }
      if (pictures.length > 1) {
        groups.push({ kind: "pictures", pictures });
        continue;
      }
    }
    groups.push({ kind: "single", attachment, index });
  }
  return groups;
}
