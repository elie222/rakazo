/** A textarea normalizes CRLF to LF; the server uses offsets in the saved string. */
export function memoryLineSelection(
  content: string,
  displayed: string,
  from: number,
  to: number,
): { start: number; end: number; expected: string } | null {
  if (
    content.replace(/\r\n?/g, "\n") !== displayed ||
    from < 0 ||
    to <= from ||
    to > displayed.length ||
    displayed.slice(from, to).includes("\n")
  )
    return null;
  const rawOffset = (position: number) => {
    let raw = 0;
    for (let offset = 0; offset < position; offset += 1) {
      if (content[raw] === "\r" && content[raw + 1] === "\n") raw += 1;
      raw += 1;
    }
    return raw;
  };
  const selectedStart = rawOffset(from);
  const selectedEnd = rawOffset(to);
  const start =
    Math.max(
      content.lastIndexOf("\n", selectedStart - 1),
      content.lastIndexOf("\r", selectedStart - 1),
    ) + 1;
  const remaining = content.slice(selectedEnd).search(/[\r\n]/);
  const end = remaining < 0 ? content.length : selectedEnd + remaining;
  return end > start ? { start, end, expected: content.slice(start, end) } : null;
}
