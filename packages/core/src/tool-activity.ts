import type { MessageBlock } from "@rakazo/contracts";

/**
 * An import checklist with nothing left on it: emptied (as Undo retires it, so older clients
 * hide it too) or marked undone. It shows nothing anywhere.
 */
export function isRetiredImportSetup(block: MessageBlock): boolean {
  return block.kind === "import_setup" && (block.undone === true || block.items.length === 0);
}

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}
