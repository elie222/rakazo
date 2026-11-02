/** Replace exactly the text the user selected in the revision they viewed. */
export function editMemoryEntry(
  content: string,
  start: number,
  end: number,
  expected: string,
  replacement: string,
): string {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    content.slice(start, end) !== expected ||
    (start > 0 && content[start - 1] !== "\n" && content[start - 1] !== "\r") ||
    (end < content.length && content[end] !== "\n" && content[end] !== "\r") ||
    /[\r\n]/.test(expected) ||
    /[\r\n]/.test(replacement) ||
    splitsSurrogate(content, start) ||
    splitsSurrogate(content, end)
  ) {
    throw new Error("Memory selection changed");
  }
  return content.slice(0, start) + replacement + content.slice(end);
}

function splitsSurrogate(text: string, position: number): boolean {
  const previous = text.charCodeAt(position - 1);
  const next = text.charCodeAt(position);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
