export type InlinePart = {
  kind: "text" | "code";
  value: string;
};

const inlineCodePattern = () => /`([^`]+)`/g;

/** Split a comparison string into text and single-backtick code spans. */
export function splitInlineCode(value: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const match of value.matchAll(inlineCodePattern())) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", value: value.slice(last, index) });
    parts.push({ kind: "code", value: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < value.length || parts.length === 0) {
    parts.push({ kind: "text", value: value.slice(last) });
  }
  return parts;
}

/** Visible text after inline code markers are rendered as elements. */
export function visibleInlineCode(value: string): string {
  return value.replace(inlineCodePattern(), "$1");
}
