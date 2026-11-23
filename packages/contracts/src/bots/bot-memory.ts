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
  /** One line describing what the note holds; null when the writer gave none. */
  description: z.string().nullable().default(null),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

/** Who wrote a revision; a row written before kinds existed reads as "user". */
export const MemorySourceKindSchema = z.enum(["user", "bot", "dream", "import", "undo"]);
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;

/** One entry in a document's history, without the content it held. */
export const MemoryRevisionSummarySchema = z.object({
  id: Id,
  revision: z.number().int().positive(),
  sourceKind: MemorySourceKindSchema.default("user"),
  createdAt: z.string(),
});
export type MemoryRevisionSummary = z.infer<typeof MemoryRevisionSummarySchema>;

export const MemoryRevisionSchema = MemoryRevisionSummarySchema.extend({
  path: z.string(),
  content: z.string(),
});
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;

/** One nightly consolidation, as the Memory page lists it. */
export const MemoryDreamStatusSchema = z.enum(["queued", "completed", "failed"]);
/**
 * Why a consolidation ran: the chat went quiet, messages piled up, the notes filled up, the
 * daily review, or a person asked. Rows written before reasons existed read as "idle".
 */
export const MemoryDreamReasonSchema = z.enum(["idle", "batch", "tidy", "review", "manual"]);
export type MemoryDreamReason = z.infer<typeof MemoryDreamReasonSchema>;
export const MemoryDreamSchema = z.object({
  id: Id,
  /** The run that did the work; null when an imported dream has no run to undo. */
  runId: Id.nullable().default(null),
  status: MemoryDreamStatusSchema,
  reason: MemoryDreamReasonSchema.default("idle"),
  summary: z.string().nullable(),
  changedPaths: z.array(z.string()),
  /** Lines the run added to the notes, one fact per line. */
  added: z.array(z.string()).default([]),
  /** Lines the run removed from the notes. */
  archived: z.array(z.string()).default([]),
  errorKind: z.string().nullable(),
  /** When a person undid this dream; null while it stands. */
  undoneAt: z.string().nullable().default(null),
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
  totalTokens: z.number().int().nonnegative().default(0),
  includedTokens: z.number().int().nonnegative().default(0),
  truncated: z.boolean(),
});
export type MemoryPromptDocumentUse = z.infer<typeof MemoryPromptDocumentUseSchema>;

export const MemoryPromptBudgetSchema = z.object({
  limitBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
  /** The bot's own notes against their cap, in tokens. */
  limitTokens: z.number().int().nonnegative().default(0),
  usedTokens: z.number().int().nonnegative().default(0),
  documents: z.array(MemoryPromptDocumentUseSchema),
  omitted: z.array(MemoryPromptDocumentUseSchema),
});
export type MemoryPromptBudget = z.infer<typeof MemoryPromptBudgetSchema>;

/** Every bot and Space keeps its MEMORY.md index; other memory documents can be deleted. */
export const MEMORY_INDEX_PATH = "MEMORY.md";
/** Tokens each layer may hold; people can still write more by hand. */
export const MEMORY_TOKEN_CAPS = { shared: 400, bot: 1_200 } as const;
/** One fact per line, and no line longer than this. */
export const MEMORY_LINE_TOKEN_CAP = 150;
/** A long-form note's own cap, and how many notes one layer may hold. */
export const MEMORY_NOTE_TOKEN_CAP = 2_000;
export const MEMORY_NOTES_PER_LAYER = 20;
export function isDeletableMemoryDocument(path: string): boolean {
  return path !== MEMORY_INDEX_PATH;
}
