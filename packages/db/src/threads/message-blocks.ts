import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma } from "../database/client.js";
import { warnJsonColumnOnce } from "../database/json-column.js";

type StoredMessage = { id: string; blocks: unknown };

/**
 * What every reader relies on before it looks at a block: an object that names its kind. A
 * kind's own fields stay as written, because rows from earlier releases hold kinds and fields
 * today's MessageBlock schema rejects; a reader that acts on those fields parses the block with
 * that schema.
 */
function isStoredBlock(entry: unknown): entry is MessageBlock {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    typeof (entry as { kind?: unknown }).kind === "string"
  );
}

function warnDropped(message: StoredMessage, dropped: number | "all") {
  warnJsonColumnOnce(
    "Stored message blocks hold entries that are not blocks; reading the rest",
    { table: "messages", column: "blocks", id: message.id },
    { dropped },
  );
}

export type StoredMessageBlocks = {
  blocks: MessageBlock[];
  /**
   * False when the row is not a list or lost entries. A block missing from such a row proves
   * nothing, so a reader that widens access or picks a destination from its absence takes the
   * restrictive answer.
   */
  intact: boolean;
};

/**
 * A stored message's blocks, checked entry by entry: every entry that names its kind is kept and
 * the rest are dropped with one warning per row, so a block is found whatever sits beside it. A
 * value that is not a list reads as no blocks.
 */
export function readMessageBlocks(message: StoredMessage): StoredMessageBlocks {
  if (!Array.isArray(message.blocks)) {
    warnDropped(message, "all");
    return { blocks: [], intact: false };
  }
  const blocks = message.blocks.filter(isStoredBlock);
  const dropped = message.blocks.length - blocks.length;
  if (dropped > 0) warnDropped(message, dropped);
  return { blocks, intact: dropped === 0 };
}

/** The blocks of `readMessageBlocks`, for a reader that decides nothing from a missing block. */
export function storedMessageBlocks(message: StoredMessage): MessageBlock[] {
  return readMessageBlocks(message).blocks;
}

/**
 * Whether a stored message came from a group, or may have: a row that lost entries may have lost
 * its channel marker, so it is never taken as the owner's own private message.
 */
export function mayBeChannelMessage(message: StoredMessage): boolean {
  const { blocks, intact } = readMessageBlocks(message);
  return !intact || blocks.some((block) => block.kind === "channel_message");
}

/**
 * A stored message's blocks with `change` applied, for writing back. `stored` is the row's own
 * list with only the changed blocks replaced, so entries a read drops are written back as they
 * were; `blocks` is the same list as readers see it. Null when `change` returned every block
 * itself or the row holds no list: there is nothing to write.
 */
export function changeMessageBlocks(
  message: StoredMessage,
  change: (block: MessageBlock) => MessageBlock,
): { stored: Prisma.InputJsonArray; blocks: MessageBlock[] } | null {
  if (!Array.isArray(message.blocks)) {
    warnDropped(message, "all");
    return null;
  }
  let changed = false;
  const blocks: MessageBlock[] = [];
  const stored = message.blocks.map((entry: unknown) => {
    if (!isStoredBlock(entry)) return entry;
    const next = change(entry);
    if (next !== entry) changed = true;
    blocks.push(next);
    return next;
  });
  if (blocks.length < stored.length) warnDropped(message, stored.length - blocks.length);
  return changed ? { stored: stored as Prisma.InputJsonArray, blocks } : null;
}
