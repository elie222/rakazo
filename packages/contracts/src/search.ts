import * as z from "zod";
import { Id } from "./ids.js";

export const SearchHitKindSchema = z.enum(["conversation", "message", "file", "link", "routine"]);
export type SearchHitKind = z.infer<typeof SearchHitKindSchema>;

export const SearchHitSchema = z.object({
  kind: SearchHitKindSchema,
  botId: Id,
  botName: z.string(),
  title: z.string(),
  snippet: z.string(),
  messageId: Id.optional(),
  seq: z.number().int().nonnegative().optional(),
  artifactId: Id.optional(),
  routineId: Id.optional(),
  url: z.string().optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchQueryOutputSchema = z.object({
  hits: z.array(SearchHitSchema).max(25),
});
export type SearchQueryOutput = z.infer<typeof SearchQueryOutputSchema>;
