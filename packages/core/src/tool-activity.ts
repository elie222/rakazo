import type { MessageBlock } from "@rakazo/contracts";

/** Undo empties the checklist as well as marking it, so older clients hide it too. */
export function isRetiredImportSetup(block: MessageBlock): boolean {
  return block.kind === "import_setup" && (block.undone === true || block.items.length === 0);
}

export function isToolActivityBlock(block: MessageBlock): boolean {
  return block.kind === "steps" || (block.kind === "progress" && block.activity === true);
}

/** Where a device keeps whether it shows tool activity. */
export const TOOL_ACTIVITY_STORAGE_KEY = "rakazo.showToolActivity";

export type ToolActivityPreference = "on" | "off";

/** Only a saved "on" shows tool cards. Missing or unreadable storage stays off so chats stay clean. */
export function normalizeToolActivityPreference(
  raw: string | null | undefined,
): ToolActivityPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}
