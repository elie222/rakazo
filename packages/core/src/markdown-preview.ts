/**
 * Markdown → a single-line plaintext preview.
 *
 * For surfaces that show a message as a plain string — the sidebar preview,
 * a push notification body — not as rendered Markdown. Drops syntax rather
 * than escaping it: emphasis and headings lose their markers, a link keeps
 * its label over its URL, a code span keeps its contents. Callers should
 * truncate the *result* of this function, never the raw source, so a cut
 * preview never ends on a dangling token like a stray `**`.
 */
export function previewText(input: string): string {
  if (!input) return "";
  let text = input;

  // Fenced code: keep the code, drop the fence markers.
  text = text.replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, body: string) => ` ${body} `);
  text = text.replace(/~~~[^\n]*\n([\s\S]*?)(?:~~~|$)/g, (_m, body: string) => ` ${body} `);

  // Images: keep the alt text. Links: keep the label, drop the URL.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");

  // Tables: each row becomes its cells, comma-joined; separator rows drop out.
  // Anchored to [ \t], not \s — \s matches newlines too, and a greedy trailing
  // \s*$ would swallow the line break into the next row and glue them together.
  text = text.replace(/^[ \t]*\|?[ \t:-]*\|[ \t|:-]*$/gm, "");
  text = text.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(", "),
  );

  // Inline code: keep the contents, drop the backticks.
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Headings, list markers, blockquotes, checkboxes, horizontal rules.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");
  text = text.replace(/\[[ xX]\]\s*/g, "");

  // Emphasis and strikethrough.
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // Collapse to a single line.
  text = text.replace(/\s+/g, " ").trim();

  return text;
}
