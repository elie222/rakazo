/** Markdown source → a single plain line for previews and notifications. */
export function plainTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/~~~[\w-]*\n?([\s\S]*?)~~~/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)([^*_\n]+)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip Markdown first so truncation cannot land inside a marker. */
export function truncatedPlainText(markdown: string, maxChars: number): string {
  return plainTextFromMarkdown(markdown).slice(0, maxChars);
}
