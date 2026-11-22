import type { Middleware } from "react-native-svg";

/** Icons larger than this fall back to their initial rather than parsing unbounded artwork. */
export const MAX_CATALOG_SVG_LENGTH = 512 * 1024;

/** Normalize parsed style properties, leaving SVG text and other attributes untouched. */
export const catalogSvgStyles: Middleware = (root) => {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const style = node.props.style;
    if (style && typeof style === "object") {
      for (const [property, value] of Object.entries(style)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trimEnd();
        if (trimmed.slice(-9).toLowerCase() !== "important") continue;
        const beforeWord = trimmed.slice(0, -9).trimEnd();
        if (beforeWord.endsWith("!")) style[property] = beforeWord.slice(0, -1).trimEnd();
      }
    }
    for (const child of node.children) if (typeof child !== "string") pending.push(child);
  }
  return root;
};
