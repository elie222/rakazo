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

export const CreateScratchpadItemInput = z.object({
  botId: Id,
  title: z.string().min(1).max(200),
  status: ScratchpadItemStatusSchema.default("open"),
  notes: z.string().max(4_000).default(""),
});
