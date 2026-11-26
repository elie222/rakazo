import * as z from "zod";
import { Id } from "../ids.js";

export const DRAFT_LABEL_MAX_LENGTH = 60;
export const DRAFT_TO_MAX_LENGTH = 200;
export const DRAFT_SUBJECT_MAX_LENGTH = 300;
export const DRAFT_BODY_MAX_LENGTH = 12_000;

/**
 * Something the user will send themselves (an email, a chat or social message, a post), drawn as
 * a card they can copy, mark up and have revised. A revision rewrites the same card. The limits
 * bind what the bot writes; a stored card is not dropped for growing past them when redacted.
 */
export const DraftBlockSchema = z.object({
  kind: z.literal("draft"),
  draftId: Id,
  /** What the draft is, in the bot's words: "Email", "LinkedIn message". */
  label: z.string().min(1),
  to: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().min(1),
  version: z.number().int().positive(),
});
export type DraftBlock = z.infer<typeof DraftBlockSchema>;
