/** Every case-insensitive match of `query` in the text under `root`, in document order. */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle.trim()) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const haystack = text.toLocaleLowerCase();
    // Lowercasing can change a string's length; offsets only line up when it did not.
    if (haystack.length !== text.length) continue;
    for (
      let at = haystack.indexOf(needle);
      at !== -1;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}
