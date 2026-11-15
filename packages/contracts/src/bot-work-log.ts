import * as z from "zod";
import { ComputerCommandSchema } from "./events.js";

export const BOT_WORK_LOG_LIMIT = 100;

/** One tool a bot called. A computer tool also carries what it did there: a command, or a file's path and size. */
export const BotWorkLogEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  runId: z.string().nullable(),
  tool: z.string(),
  action: ComputerCommandSchema.optional(),
});
export type BotWorkLogEntry = z.infer<typeof BotWorkLogEntrySchema>;
