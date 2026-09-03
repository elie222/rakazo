import type { ThreadMessage } from "@rakazo/contracts";
import { providerLabel } from "./messaging";

/** Plain message text for clipboard copy — text/ask/progress only, no chrome. */
export function copyableMessageText(message: ThreadMessage): string {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") {
        return `${providerLabel(block.provider)} · ${block.fromLabel}: ${block.text}`;
      }
      if (block.kind === "text" || block.kind === "progress" || block.kind === "ask") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
