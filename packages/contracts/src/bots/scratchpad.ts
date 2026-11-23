import * as z from "zod";
import { Id } from "../ids.js";

export const ScratchpadItemStatusSchema = z.enum(["open", "parked", "done"]);

export const ScratchpadItemSchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  status: ScratchpadItemStatusSchema,
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScratchpadItem = z.infer<typeof ScratchpadItemSchema>;

/** Trimmed like the bot name, so a blank title is refused instead of stored. */
export const ScratchpadItemTitle = z.string().trim().min(1).max(200);

export const CreateScratchpadItemInput = z.object({
  botId: Id,
  title: ScratchpadItemTitle,
  status: ScratchpadItemStatusSchema.default("open"),
  notes: z.string().max(4_000).default(""),
});
