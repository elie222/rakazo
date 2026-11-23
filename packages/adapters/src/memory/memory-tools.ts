import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BOT_MEMORY_MAX_BYTES } from "@rakazo/contracts";
import { byteLength } from "@rakazo/core";
import { z } from "zod";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
  "reflect_memory",
]);

/** `forget_memory` and `reflect_memory` are offered only when the provider implements that optional verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
  semanticMemoryReflects: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter(
        (tool) =>
          (semanticMemoryForgets || tool.name !== "forget_memory") &&
          (semanticMemoryReflects || tool.name !== "reflect_memory"),
      )
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") && current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n` : `${next}\n`;
}

export const RememberInputSchema = z.object({
  operations: z
    .array(
      z.object({
        action: z.enum(["add", "replace", "remove"]),
        content: z.string().optional(),
        old_text: z.string().optional(),
      }),
    )
    .min(1),
});
type MemoryOperation = z.infer<typeof RememberInputSchema>["operations"][number];
export type MemoryEdit = { content: string } | { error: string; entries: string[] };
type EntryRange = { start: number; end: number };

/**
 * Applies every operation in order, or none: one that fails leaves memory as it was.
 * The size cap is checked on the result only, so one call can make room and add a fact.
 */
export function editMemory(
  existing: string,
  operations: readonly MemoryOperation[],
  maxBytes = BOT_MEMORY_MAX_BYTES,
): MemoryEdit {
  let content = existing;
  for (const [index, operation] of operations.entries()) {
    const result = applyOperation(content, operation);
    if ("error" in result) {
      const which = operations.length > 1 ? `Operation ${index + 1}: ` : "";
      return { ...result, error: `${which}${result.error} Nothing was saved.` };
    }
    content = result.content;
  }
  const bytes = byteLength(content);
  if (bytes > maxBytes && bytes > byteLength(existing)) {
    const over = bytes - maxBytes;
    return {
      error: `Memory is full: this would be ${over} bytes over the ${maxBytes}-byte limit, so nothing was saved. Send one remember call whose operations remove or shorten entries to free at least ${over} bytes and also make this change.`,
      entries: entriesOf(existing),
    };
  }
  return { content };
}

function applyOperation(current: string, operation: MemoryOperation): MemoryEdit {
  const fact = (operation.content ?? "").trim().replace(/\r\n/g, "\n");
  if (operation.action === "add") {
    return fact
      ? { content: appendMemoryFact(current, fact) }
      : { error: "add needs content.", entries: [] };
  }
  const target = (operation.old_text ?? "").trim().replace(/\r\n/g, "\n");
  if (!target) return { error: `${operation.action} needs old_text.`, entries: [] };
  const lines = current.replace(/\r\n/g, "\n").split("\n");
  const found = findEntry(lines, target);
  if ("error" in found) return found;
  const next = operation.action === "replace" && fact ? fact.split("\n") : [];
  return {
    content: [...lines.slice(0, found.start), ...next, ...lines.slice(found.end + 1)].join("\n"),
  };
}

/**
 * The entry (line, or lines for a multi-line quote) old_text names: a whole entry first,
 * then an exact quote, then one that differs only in quotes, dashes or spacing. Identical
 * matches count as one, so a duplicated entry can still be changed.
 */
function findEntry(
  lines: string[],
  target: string,
): EntryRange | { error: string; entries: string[] } {
  const tiers = [
    () => lines.flatMap((line, i) => (line.trim() === target ? [{ start: i, end: i }] : [])),
    () => quoted(lines, target),
    () => {
      const loose = normalized(target);
      return lines.flatMap((line, i) =>
        line.trim() && normalized(line).includes(loose) ? [{ start: i, end: i }] : [],
      );
    },
  ];
  for (const tier of tiers) {
    const matches = tier();
    if (!matches.length) continue;
    const texts = new Set(matches.map((m) => lines.slice(m.start, m.end + 1).join("\n")));
    if (texts.size === 1) return matches[0]!;
    return {
      error: "old_text matches more than one entry. Quote more of the one to change.",
      entries: [...texts],
    };
  }
  return {
    error: "No entry matches old_text. Quote the entry as it is written; the closest are listed.",
    entries: closestEntries(lines, target),
  };
}

function quoted(lines: string[], target: string): EntryRange[] {
  const text = lines.join("\n");
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const ranges = new Map<number, EntryRange>();
  for (let at = text.indexOf(target); at !== -1; at = text.indexOf(target, at + 1)) {
    const start = lineAt(at);
    if (!ranges.has(start)) ranges.set(start, { start, end: lineAt(at + target.length - 1) });
  }
  return [...ranges.values()];
}

function normalized(text: string): string {
  return text
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function closestEntries(lines: string[], target: string): string[] {
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const wanted = words(target);
  return entriesOf(lines.join("\n"))
    .map((entry) => ({ entry, score: [...words(entry)].filter((w) => wanted.has(w)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ entry }) => entry);
}

function entriesOf(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim());
}
