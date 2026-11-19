import { getLogger } from "@rakazo/logging";
import type { Root } from "chat";
import { parseMarkdown, stringifyMarkdown, toPlainText } from "chat";

/** How one platform measures a message. */
export interface MessageLimit {
  /** The most UTF-16 units one message holds. */
  limit: number;
  /** Every text the platform's adapter may send for a Markdown part: its rendering and any fallback. */
  sent: (markdown: string) => string[];
}

/** The fields of a parsed Markdown node that splitting reads. */
interface Node {
  type: string;
  children?: Node[];
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  ordered?: boolean | null;
  start?: number | null;
  identifier?: string;
  label?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
}

/** Puts a piece of a node into a part, as that part's whole tree. */
type Place<Piece = Node> = (piece: Piece) => Node;

interface Cut {
  head: Node | null;
  rest: Node | null;
}

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Splits a Markdown reply into Markdown parts that each fit one message as the platform sends it,
 * so every part goes through the rendering a short reply gets. Parts end between blocks where they
 * can. A block too big for one message is split inside, and each piece keeps its code fence, list,
 * quote or emphasis, so every part reads on its own.
 */
export function splitMarkdown(body: string, platform: MessageLimit): string[] {
  if (!body.trim()) return [];
  try {
    if (fitsMessage(body, platform)) return [body];
    return splitTree(body, inlineReferences(parseMarkdown(body) as Node), platform);
  } catch (error) {
    // The parser and renderers recurse once per nesting level, so hundreds of nested markers
    // overflow the stack. The reply goes out as the text it was written as instead of failing.
    getLogger().warn("sending a whole reply as literal text: splitting its Markdown failed", {
      error,
    });
    return splitTree(body, { type: "root", children: [paragraph(text(body))] }, platform);
  }
}

function asRoot(node: Node): Root {
  return node as unknown as Root;
}

function text(value: string): Node {
  return { type: "text", value };
}

function paragraph(...children: Node[]): Node {
  return { type: "paragraph", children };
}

/**
 * Writes reference-style links and images as inline ones and drops their definitions: each part
 * is parsed alone, without a definition that landed in another part. Footnotes have no inline
 * form and no platform shows them as footnotes, so their markers and text stay as written.
 */
function inlineReferences(root: Node): Node {
  const definitions = new Map<string, Node>();
  const collect = (node: Node) => {
    if (node.type === "definition" && node.identifier && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);

  const inline = (node: Node): Node[] => {
    const children = () => (node.children ?? []).flatMap(inline);
    const definition = definitions.get(node.identifier ?? "");
    const marker = () => text(`[^${node.label ?? node.identifier}]`);
    switch (node.type) {
      case "definition":
        return [];
      case "linkReference":
        if (!definition) return [node];
        return [
          { type: "link", url: definition.url, title: definition.title, children: children() },
        ];
      case "imageReference":
        if (!definition) return [node];
        return [{ type: "image", url: definition.url, title: definition.title, alt: node.alt }];
      case "footnoteReference":
        return [marker()];
      case "footnoteDefinition": {
        // Its blocks are indented in the source, so they are written out again, not copied.
        const blocks = children().map((block) => ({ ...block, position: undefined }));
        const [first, ...rest] = blocks;
        return first?.type === "paragraph"
          ? [paragraph(marker(), text(": "), ...(first.children ?? [])), ...rest]
          : [paragraph(marker(), text(":")), ...blocks];
      }
    }
    if (!node.children) return [node];
    const changed = children();
    if (
      changed.length === node.children.length &&
      changed.every((child, index) => child === node.children?.[index])
    )
      return [node];
    // A quote or list item that held only definitions has nothing left to show.
    if (changed.length === 0 && node !== root) return [];
    // Without its position the block is written out again instead of copied from the source.
    return [{ ...node, children: changed, position: undefined }];
  };
  return inline(root)[0] ?? root;
}

/** The types whose children are inline content, and those whose children are blocks. */
const INLINE_PARENTS = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "tableCell",
]);
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem"]);

/** `child` as the Markdown text it is written as, in place of it under `parent`. */
function literal(parent: Node, child: Node): Node | null {
  const inline = INLINE_PARENTS.has(parent.type);
  if (child.type === "text" || !(inline || BLOCK_PARENTS.has(parent.type))) return null;
  const block = inline ? paragraph(child) : child;
  const written = text(stringifyMarkdown(asRoot({ type: "root", children: [block] })).trimEnd());
  return inline ? written : paragraph(written);
}

function fitsMessage(markdown: string, { limit, sent }: MessageLimit): boolean {
  return markdown.length <= limit && sent(markdown).every((text) => text.length <= limit);
}

function splitTree(source: string, root: Node, platform: MessageLimit): string[] {
  const { limit, sent } = platform;
  const blocks = root.children ?? [];
  // Blocks the parser read from the source; the literal fallback has none.
  const whole = new Set(blocks.filter((block) => block.position));
  const sourceOf = (block: Node) =>
    source.slice(block.position?.start.offset, block.position?.end.offset);

  const written = new WeakMap<Node, string>();
  /** A whole block keeps its source text; only a piece of one is written out again. */
  const serialize = (part: Node): string =>
    (part.children ?? [])
      .map((block) => {
        let markdown = written.get(block);
        if (markdown === undefined) {
          markdown = whole.has(block)
            ? sourceOf(block)
            : stringifyMarkdown(asRoot({ type: "root", children: [block] })).trimEnd();
          written.set(block, markdown);
        }
        return markdown;
      })
      .join("\n\n");
  // A node is never written out shorter than its text, so most candidates that do not fit are
  // ruled out by adding lengths up, without writing them out and rendering them.
  const lengths = new WeakMap<Node, number>();
  const textLength = (node: Node): number => {
    let length = lengths.get(node);
    if (length === undefined) {
      length = node.value?.length ?? 0;
      for (const child of node.children ?? []) length += textLength(child);
      lengths.set(node, length);
    }
    return length;
  };
  const fits = (part: Node) => textLength(part) <= limit && fitsMessage(serialize(part), platform);

  /**
   * Takes from the front of `node` what the part being filled still holds. `lead` places a piece
   * after what that part already has, `alone` at the start of an empty part.
   */
  const take = (node: Node, lead: Place<Node | null>, alone: Place, started: boolean): Cut => {
    const { children, value } = node;
    if (children?.length) {
      const piece = (items: Node[], first = 0): Node => ({
        ...node,
        children: items,
        ...(node.ordered ? { start: (node.start ?? 1) + first } : {}),
      });
      let guess = 0;
      for (let length = 0; guess < children.length; guess++) {
        const { position } = children[guess]!;
        length += position ? (position.end.offset ?? 0) - (position.start.offset ?? 0) : 0;
        if (length > limit) break;
      }
      const count = largestFitting(children.length, guess, (n) =>
        fits(lead(piece(children.slice(0, n)))),
      );
      const next = children[count];
      if (!next) return { head: node, rest: null };
      const leading = children.slice(0, count);
      const here = (extra: Node | null) =>
        extra || count > 0 ? piece(extra ? [...leading, extra] : leading) : null;
      const begun = started || count > 0;
      // A block moves to the next part whole when it fits one, or when this part is half full.
      const endsHere =
        begun &&
        (serialize(lead(here(null))).length >= limit / 2 || fits(alone(piece([next], count))));
      const inside = (child: Node) =>
        take(
          child,
          (head) => lead(here(head)),
          (rest) => alone(piece([rest], count)),
          begun,
        );
      let cut = endsHere ? { head: null, rest: next } : inside(next);
      if (!cut.head && !begun) {
        // Nothing of `next` fits a part of its own, such as a link whose address is longer than a
        // message. Only it is sent as the text it was written as, which splits anywhere.
        const asText = literal(node, next);
        if (asText) cut = inside(asText);
        if (!cut.head) return { head: null, rest: node };
      }
      const after = children.slice(count + 1);
      return {
        head: here(cut.head),
        rest: cut.rest
          ? piece([cut.rest, ...after], count)
          : after.length > 0
            ? piece(after, count + 1)
            : null,
      };
    }
    if (!value) return { head: null, rest: node };
    const max = largestFitting(Math.min(value.length, limit), limit, (n) =>
      fits(lead({ ...node, value: value.slice(0, n) })),
    );
    if (max === value.length) return { head: node, rest: null };
    const code = node.type === "code";
    const end = (max && breakBefore(value, max, code)) || (started ? 0 : max);
    if (!end) return { head: null, rest: node };
    // A code block's pieces are whole lines, so the line break at the cut is not part of either.
    const resume = code && value[end] === "\n" ? end + 1 : end;
    return {
      head: { ...node, value: value.slice(0, end) },
      rest: resume < value.length ? { ...node, value: value.slice(resume) } : null,
    };
  };

  const parts: string[] = [];
  let rest: Node | null = root;
  while (rest) {
    let head: Node | null = rest;
    if (fits(rest)) rest = null;
    else
      ({ head, rest } = take(
        rest,
        (piece) => piece ?? { ...root, children: [] },
        (piece) => piece,
        false,
      ));
    if (!head) throw new Error("No part of the reply fits one message");
    head = trimEdge(head, true);
    rest = rest && trimEdge(rest, false);
    if (!head) continue;
    const part = serialize(head);
    // Platforms reject a message with nothing to show, such as blank lines or a lone definition.
    if (toPlainText(asRoot(head)).trim() && sent(part).every((text) => text.trim()))
      parts.push(part);
  }
  return parts;
}

/** The most leading items that fit, trying `guess` first; fewer items are taken to fit if more do. */
function largestFitting(max: number, guess: number, fits: (count: number) => boolean): number {
  if (max < 1) return 0;
  let low = 0;
  let high = Math.min(Math.max(guess, 1), max);
  while (high <= max && fits(high)) {
    low = high;
    high = high === max ? max + 1 : Math.min(high * 2, max);
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * Where to end a piece of text that fits up to `max`: a line break, else a space, in its second
 * half, else the last whole character. Code only breaks between lines while it has any.
 */
function breakBefore(value: string, max: number, code: boolean): number {
  const least = code ? 1 : Math.max(max / 2, 1);
  const line = value.lastIndexOf("\n", max);
  if (line >= least) return line;
  const space = code ? -1 : value.slice(0, max + 1).search(/\s\S*$/);
  if (space >= least) return space;
  // Emoji such as flags and skin tones are several code points that show as one character.
  return characters.segment(value).containing(max)?.index ?? max;
}

/** Drops the white space and line breaks a cut leaves at the end or start of a part. */
function trimEdge(node: Node, end: boolean): Node | null {
  if (node.type === "break") return null;
  if (node.type === "text") {
    const value = end ? node.value?.trimEnd() : node.value?.trimStart();
    if (value === node.value) return node;
    return value ? { ...node, value } : null;
  }
  if (!node.children?.length) return node;
  const children = [...node.children];
  while (children.length > 0) {
    const index = end ? children.length - 1 : 0;
    const child = children[index]!;
    const trimmed = trimEdge(child, end);
    if (trimmed === child)
      return children.length === node.children.length ? node : { ...node, children };
    if (trimmed) {
      children[index] = trimmed;
      return { ...node, children };
    }
    children.splice(index, 1);
  }
  return node.type === "root" ? { ...node, children } : null;
}
