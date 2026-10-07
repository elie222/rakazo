import { z } from "zod";
import { Id } from "./ids.js";

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  before: z.iso.datetime().optional(),
  after: z.iso.datetime().optional(),
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export const HistoryReadInputSchema = z.object({
  messageId: Id,
  linkedRunId: Id.optional(),
  runAfterId: Id.optional(),
  artifactAfterId: Id.optional(),
  outcomeAfterSeq: z.number().int().nonnegative().optional(),
  textOffset: z.number().int().nonnegative().optional(),
  direction: z.enum(["around", "older", "newer"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
export type HistorySearchInput = z.infer<typeof HistorySearchInputSchema>;
export type HistoryReadInput = z.infer<typeof HistoryReadInputSchema>;
