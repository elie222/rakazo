import { z } from "zod";

export const OutgoingDraftValues = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("email"),
      to: z.email().max(254),
      subject: z
        .string()
        .max(998)
        .regex(/^[^\r\n]*$/),
      body: z.string().max(16_000),
    })
    .refine(({ subject, body }) => subject.trim().length > 0 || body.trim().length > 0),
  z.strictObject({
    kind: z.literal("message"),
    // The connector owns its destination format. A review card takes one bounded, visible line.
    to: z.string().min(1).max(254).regex(/^\S+$/),
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

/** Only a committed card replaces local edits with the server's reviewed values. */
export function outgoingDraftPresentation(
  card: { status?: "pending" | "answered"; answer?: string; expired?: true },
  stored: OutgoingDraftValues,
  edited: OutgoingDraftValues,
  canAnswer: boolean,
  submitted?: string,
) {
  const resolved = card.status === "answered" ? card.answer : undefined;
  const decision = resolved ?? submitted;
  const status = card.expired
    ? "expired"
    : decision === "deny"
      ? "discarded"
      : decision
        ? "approved"
        : canAnswer
          ? "pending"
          : "inactive";
  const shown = card.status === "answered" ? stored : edited;
  return { status, shown, isEmail: shown.kind === "email" };
}

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
