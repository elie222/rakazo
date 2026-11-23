import { CARD_TITLE_ESCAPED_CHARACTERS } from "@rakazo/core";

const ESCAPED = new RegExp(`\\\\(${CARD_TITLE_ESCAPED_CHARACTERS})`, "g");

/** An ask title as plain text: the names in it were escaped for web's Markdown rendering. */
export function plainAskTitle(text: string): string {
  return text.replace(ESCAPED, "$1");
}
