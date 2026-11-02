/** Preserve UTF-16 positions, which are the positions accepted by the API. */
export function memoryEntries(
  content: string,
): Array<{ start: number; end: number; text: string }> {
  return Array.from(content.matchAll(/[^\r\n]+/g), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
}
