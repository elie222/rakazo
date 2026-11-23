import * as z from "zod";
import { Id, MemoryScope } from "../ids.js";

export function isEmptyBotMemory(doc: Pick<MemoryDocument, "path" | "content">): boolean {
  if (!doc.content.trim()) return true;
  if (doc.path !== MEMORY_INDEX_PATH) return false;
  // Bots created before memory started empty were seeded with `# <name>\n\n`. Match that
  // whole shape; the bot may have been renamed since, so its current name is no baseline.
  return /^# [^\n]*\n\n$/.test(doc.content);
}

/**
 * What people call a memory document. The main notes have no name of their own: they are
 * the memory itself, so the stored file name never reaches the screen.
 */
export function memoryDocumentName(path: string): string | null {
  if (path === MEMORY_INDEX_PATH) return null;
  // Keep folders, so two documents never share a name, and keep a name that is only ".md".
  return path.replace(/\.md$/i, "") || path;
}

/**
 * The first note in a memory document, past any headings. Notes made only of headings show
 * their first heading's text. An untouched index shows nothing.
 */
export function memoryNotesPreview(doc: Pick<MemoryDocument, "path" | "content">): string {
  if (isEmptyBotMemory(doc)) return "";
  const lines = doc.content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.startsWith("#")) ?? (lines[0] ?? "").replace(/^#+\s*/, "");
}

export const MemoryScopeSchema = z.enum(["isolated", "shared"]);

export const MemoryDocumentSchema = z.object({
  id: Id,
  scope: MemoryScope,
  botId: Id.nullable(),
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

/** Which of a bot's memory documents reach the prompt, and what did not fit. */
export const MemoryPromptDocumentUseSchema = z.object({
  scope: MemoryScope,
  path: z.string(),
  revision: z.number().int(),
  totalBytes: z.number().int().nonnegative(),
  includedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type MemoryPromptDocumentUse = z.infer<typeof MemoryPromptDocumentUseSchema>;

export const MemoryPromptBudgetSchema = z.object({
  limitBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
  documents: z.array(MemoryPromptDocumentUseSchema),
  omitted: z.array(MemoryPromptDocumentUseSchema),
});
export type MemoryPromptBudget = z.infer<typeof MemoryPromptBudgetSchema>;

/** Every bot and Space keeps its MEMORY.md index; other memory documents can be deleted. */
export const MEMORY_INDEX_PATH = "MEMORY.md";
/** What a bot may write to its memory. People can still write more by hand. */
export const BOT_MEMORY_MAX_BYTES = 4 * 1024;
export function isDeletableMemoryDocument(path: string): boolean {
  return path !== MEMORY_INDEX_PATH;
}
