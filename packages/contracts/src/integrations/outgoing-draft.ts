import { z } from "zod";

export const OutgoingDraftValues = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("email"),
    to: z.email().max(254),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/),
    body: z.string().max(16_000),
  }),
  z.strictObject({
    kind: z.literal("message"),
    to: z.string().regex(/^(?:[CDGU][A-Z0-9]{1,31}|#[a-z0-9_-]{1,80})$/),
    body: z
      .string()
      .max(16_000)
      .refine((body) => body.trim().length > 0),
  }),
]);
export type OutgoingDraftValues = z.infer<typeof OutgoingDraftValues>;

const argumentKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);

export const OutgoingDraft = z.object({
  source: z.string().min(1).max(80),
  values: OutgoingDraftValues,
  keys: z.object({ to: argumentKey, body: argumentKey, subject: argumentKey.optional() }),
  batch: z
    .object({
      items: argumentKey,
      action: argumentKey,
      arguments: argumentKey,
      operation: z.string().min(1).max(200),
    })
    .optional(),
});
export type OutgoingDraft = z.infer<typeof OutgoingDraft>;

export function outgoingDraftAnswer(values: OutgoingDraftValues): string {
  return JSON.stringify({ outgoingDraft: values });
}

export const CATALOG_APPROVAL_TOOL = "__rakazoCatalogTool";

export function draftBatchEntry(
  args: Record<string, unknown>,
  batch: NonNullable<OutgoingDraft["batch"]>,
) {
  const items = args[batch.items];
  if (!Array.isArray(items) || items.length !== 1) return undefined;
  const item = z.record(z.string(), z.unknown()).safeParse(items[0]).data;
  if (!item || item[batch.action] !== batch.operation) return undefined;
  const nested = z.record(z.string(), z.unknown()).safeParse(item[batch.arguments]).data;
  return nested ? { item, args: nested } : undefined;
}
