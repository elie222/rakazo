import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/**
 * One thing that is waiting on the signed-in user across their bots. A run can appear once;
 * the item names the exact chat and card so the client can open or answer it.
 */
export const AttentionKindSchema = z.enum([
  "question",
  "approval",
  "secret",
  "takeover",
  "failed",
  "routine_delayed",
]);
export type AttentionKind = z.infer<typeof AttentionKindSchema>;

export const AttentionActionSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  /** The value the existing `threads.answer` procedure records. */
  answer: z.string().min(1).max(200),
  tone: z.enum(["primary", "secondary", "danger"]).default("secondary"),
});
export type AttentionAction = z.infer<typeof AttentionActionSchema>;

export const AttentionItemSchema = z.object({
  id: z.string().min(1).max(120),
  kind: AttentionKindSchema,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  runId: Id.nullable(),
  routineId: Id.nullable(),
  messageId: Id.nullable(),
  /** The question, approval summary, routine name or failure preview. Never a secret value. */
  detail: z.string(),
  /** When the wait started, used oldest first inside one kind. */
  createdAt: IsoDate,
  actions: z.array(AttentionActionSchema),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const AttentionListOutputSchema = z.object({
  items: z.array(AttentionItemSchema),
});
export type AttentionListOutput = z.infer<typeof AttentionListOutputSchema>;
