import * as z from "zod";
import { Id, MemoryScope } from "../ids.js";

/** The heading seeded when a bot is created, before it has learned anything. */
export function initialBotMemory(name: string): string {
  return `# ${name}\n\n`;
}

export function isEmptyBotMemory(doc: Pick<MemoryDocument, "path" | "content">): boolean {
  if (!doc.content.trim()) return true;
  if (doc.path !== MEMORY_INDEX_PATH) return false;
  // Match the seed's complete shape, including its trailing blank line. The bot
  // may have been renamed since creation, so its current name is not a baseline.
  const heading = doc.content.split("\n")[0] ?? "";
  return heading.startsWith("# ") && doc.content === initialBotMemory(heading.slice(2));
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

/** One nightly consolidation, as the Memory page lists it. */
export const MemoryDreamStatusSchema = z.enum(["queued", "completed", "failed"]);
export const MemoryDreamSchema = z.object({
  id: Id,
  status: MemoryDreamStatusSchema,
  summary: z.string().nullable(),
  changedPaths: z.array(z.string()),
  /** Lines the run added to the notes, one fact per line. */
  added: z.array(z.string()).default([]),
  /** Lines the run removed from the notes. */
  archived: z.array(z.string()).default([]),
  errorKind: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MemoryDream = z.infer<typeof MemoryDreamSchema>;

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
