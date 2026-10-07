import type { SearchHit } from "@rakazo/contracts";
import { plainTextFromMarkdown } from "@rakazo/core";

/**
 * One row per hit. Link hits in the same message share a message id and differ
 * by URL; keying only on the message id makes React warn about duplicate keys.
 */
export function searchHitListKey(hit: SearchHit): string {
  return [
    hit.kind,
    hit.groupId ?? hit.botId ?? "",
    hit.messageId ?? "",
    hit.artifactId ?? "",
    hit.routineId ?? "",
    hit.url ?? "",
  ].join("\u0000");
}

export function dedupeSearchHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of hits) {
    const key = searchHitListKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

// data:[<mediatype>][;base64],<data>. The comma is required, so `data:image/png`
// stays text; an omitted mediatype (`data:,hello`, `data:;base64,...`) still matches.
const DATA_URI = /(?<![\w])data:[^)\s,]*,[^\s)]*/gi;

/** One plain line for a search row: no markdown syntax, no data: URI text. */
export function searchHitPreview(snippet: string): string {
  const cleaned = snippet.replace(/!\[[^\]]*]\(\s*data:[^)]*$/gi, " ").replace(DATA_URI, " ");
  return plainTextFromMarkdown(cleaned);
}

export function searchHitRowPreview(
  hit: Pick<SearchHit, "groupName" | "botName" | "snippet">,
): string {
  const context = hit.groupName ?? hit.botName ?? "";
  const preview = searchHitPreview(hit.snippet);
  if (!context) return preview;
  if (!preview) return context;
  return `${context} · ${preview}`;
}
