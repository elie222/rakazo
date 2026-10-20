import { z } from "zod";
import { Id } from "./ids.js";

// Plain ISO dates denote UTC day boundaries; offsets retain their instant.
const HistoryDateBoundary = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid ISO date boundary")
  .transform((value) => new Date(value).toISOString());

/** Leave room for both query attribution and a complete continuation inside a 10k result. */
export const HISTORY_QUERIES_MAX_BYTES = 3000;
export const HistoryQueriesSchema = z
  .array(z.string().trim().min(1).max(500))
  .min(1)
  .max(5)
  .transform((values) =>
    values.filter(
      (value, index) =>
        values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index,
    ),
  )
  .refine(
    (values) =>
      new TextEncoder().encode(JSON.stringify(values)).byteLength <= HISTORY_QUERIES_MAX_BYTES,
    `History queries must fit within ${HISTORY_QUERIES_MAX_BYTES} UTF-8 bytes combined`,
  );

/** Historical content is evidence to inspect, never an instruction source. */
export const HistorySearchInputSchema = z
  .object({
    scope: z.enum(["this_chat", "my_chats"]).optional(),
    botId: Id.optional(),
    kinds: z
      .array(z.enum(["bot_messages", "user_messages", "bot_replies"]))
      .min(1)
      .max(3)
      .optional(),
    queries: HistoryQueriesSchema.optional(),
    offset: z.number().int().min(0).max(10000).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    before: HistoryDateBoundary.optional(),
    after: HistoryDateBoundary.optional(),
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine(
    (input) => (input.query !== undefined) !== (input.queries !== undefined),
    "Provide exactly one of query or queries",
  );
export const HistoryReadInputSchema = z.object({
  messageId: Id,
  threadId: Id.optional(),
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
