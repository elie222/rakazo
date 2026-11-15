import type { MessageBlock } from "@rakazo/contracts";
import { z } from "zod";
import { readJsonColumn } from "./json-column.js";

/**
 * What every reader relies on before it looks at a block: a list of objects that each name their
 * kind. A kind's own fields stay as written, because rows from earlier releases hold kinds and
 * fields today's MessageBlock schema rejects; a reader that acts on those fields parses the
 * block with that schema.
 */
const StoredMessageBlocks = z.array(
  z.custom<MessageBlock>(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      !Array.isArray(block) &&
      typeof (block as { kind?: unknown }).kind === "string",
  ),
);

/** A stored message's blocks, or none (with a warning) when the row holds something else. */
export function storedMessageBlocks(message: { id: string; blocks: unknown }): MessageBlock[] {
  return readJsonColumn(
    StoredMessageBlocks,
    message.blocks,
    { table: "messages", column: "blocks", id: message.id },
    { fallback: [] },
  );
}
