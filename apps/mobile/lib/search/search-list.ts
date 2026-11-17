import type { SearchHit } from "@rakazo/contracts";
import { plainTextFromMarkdown } from "@rakazo/core";

// data:[<mediatype>][;base64],<data>. The comma is required, so `data:image/png`
// stays text; an omitted mediatype (`data:,hello`, `data:;base64,...`) still matches.
const DATA_URI = /(?<![\w])data:[^)\s,]*,[^\s)]*/gi;

/** One plain line for a search row: no markdown syntax, no data: URI text. */
export function searchHitPreview(snippet: string): string {
  const cleaned = snippet.replace(/!\[[^\]]*]\(\s*data:[^)]*$/gi, " ").replace(DATA_URI, " ");
  return plainTextFromMarkdown(cleaned);
}

/** The snippet, after the chat it came from unless the row title already names that chat. */
export function searchHitRowPreview(
  hit: Pick<SearchHit, "title" | "groupName" | "botName" | "snippet">,
): string {
  const context = hit.groupName ?? hit.botName ?? "";
  const preview = searchHitPreview(hit.snippet);
  if (!context || context === hit.title) return preview;
  if (!preview) return context;
  return `${context}: ${preview}`;
}
