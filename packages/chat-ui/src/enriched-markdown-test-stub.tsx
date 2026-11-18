import { createElement } from "react";

/** The native Markdown view for node tests: its Markdown as plain text. */
export function EnrichedMarkdownText({ markdown }: { markdown: string }) {
  return createElement("rn-enriched-markdown", null, markdown);
}
