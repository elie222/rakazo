import type { OutgoingDraft } from "@rakazo/contracts";
import { CATALOG_APPROVAL_TOOL, draftBatchEntry, OutgoingDraftValues } from "@rakazo/contracts";
import { z } from "zod";
import { JsonObject, readJsonColumn } from "../database/json-column.js";

const DraftAnswer = z.strictObject({ outgoingDraft: OutgoingDraftValues });
const CatalogRequest = z
  .tuple(
    [
      z.literal(CATALOG_APPROVAL_TOOL),
      z.string().endsWith("_execute_tool"),
      z.looseObject({ arguments: JsonObject }),
    ],
    z.json(),
  )
  .refine((request) => request.length <= 4);
const BoundRequest = z.tuple([
  z.literal(CATALOG_APPROVAL_TOOL),
  z.literal("direct"),
  z.looseObject({ route: JsonObject, args: JsonObject }),
]);

function fieldValues(draft: OutgoingDraft, values: OutgoingDraftValues) {
  return {
    [draft.keys.to]: values.to,
    [draft.keys.body]: values.body,
    ...(draft.keys.subject && values.kind === "email"
      ? { [draft.keys.subject]: values.subject }
      : {}),
  };
}

export function editOutgoingDraft(
  effect: { id: string; request: unknown },
  draft: OutgoingDraft,
  answer: string,
) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(answer);
  } catch {
    return undefined;
  }
  const parsed = DraftAnswer.safeParse(decoded);
  if (!parsed.success || parsed.data.outgoingDraft.kind !== draft.values.kind) return undefined;
  const values = parsed.data.outgoingDraft;
  const fields = fieldValues(draft, draft.values);
  const edited = fieldValues(draft, values);
  const edit = (args: Record<string, unknown>): Record<string, unknown> | undefined => {
    const batch = draft.batch;
    const entry = batch ? draftBatchEntry(args, batch) : undefined;
    if (batch && !entry) return undefined;
    const original = entry?.args ?? args;
    const bodyWasOmitted = values.kind === "email" && !Object.hasOwn(original, draft.keys.body);
    if (
      !Object.entries(fields).every(([key, value]) =>
        key === draft.keys.body && bodyWasOmitted ? value === "" : original[key] === value,
      )
    )
      return undefined;
    const updated = { ...original, ...edited };
    if (bodyWasOmitted && values.body === "") delete updated[draft.keys.body];
    return batch && entry
      ? { ...args, [batch.items]: [{ ...entry.item, [batch.arguments]: updated }] }
      : updated;
  };
  const column = { table: "external_effects", column: "request", id: effect.id };
  if (!Array.isArray(effect.request)) {
    const args = readJsonColumn(JsonObject, effect.request, column, "reject");
    const request = edit(args);
    return request ? { values, request } : undefined;
  }
  const bound = BoundRequest.safeParse(effect.request);
  if (bound.success) {
    const [marker, tag, payload] = bound.data;
    const args = edit(payload.args);
    return args ? { values, request: [marker, tag, { ...payload, args }] } : undefined;
  }
  const [marker, tool, wrapper, ...route] = readJsonColumn(
    CatalogRequest,
    effect.request,
    column,
    "reject",
  );
  const args = edit(wrapper.arguments);
  return args
    ? { values, request: [marker, tool, { ...wrapper, arguments: args }, ...route] }
    : undefined;
}
