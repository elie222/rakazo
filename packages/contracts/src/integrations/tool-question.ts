import * as z from "zod";

/**
 * A small form a tool's server asks the person in the middle of a call (MCP elicitation, form
 * mode). Every word in it is the server's own, untrusted text: clients show it as plain text, and
 * the bot never reads it as instructions.
 */
export const TOOL_QUESTION_MESSAGE_MAX = 1_000;
export const TOOL_QUESTION_LABEL_MAX = 120;
export const TOOL_QUESTION_DESCRIPTION_MAX = 300;
export const TOOL_QUESTION_FIELDS_MAX = 10;
export const TOOL_QUESTION_OPTIONS_MAX = 25;
/** Longest text answer a field takes, whatever the server allows. */
export const TOOL_QUESTION_TEXT_MAX = 2_000;

const FieldName = z.string().min(1).max(64);
const Label = z.string().max(TOOL_QUESTION_LABEL_MAX);
const Description = z.string().max(TOOL_QUESTION_DESCRIPTION_MAX);

const FieldBase = {
  name: FieldName,
  label: Label,
  description: Description.optional(),
  required: z.boolean(),
};

export const ToolQuestionFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...FieldBase,
    type: z.literal("text"),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().max(TOOL_QUESTION_TEXT_MAX),
    default: z.string().max(TOOL_QUESTION_TEXT_MAX).optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal("number"),
    integer: z.boolean(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({ ...FieldBase, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.object({
    ...FieldBase,
    type: z.literal("choice"),
    options: z
      .array(z.object({ value: z.string().max(TOOL_QUESTION_TEXT_MAX), label: Label }))
      .min(1)
      .max(TOOL_QUESTION_OPTIONS_MAX),
    default: z.string().max(TOOL_QUESTION_TEXT_MAX).optional(),
  }),
]);
export type ToolQuestionField = z.infer<typeof ToolQuestionFieldSchema>;

export const ToolQuestionSchema = z.object({
  /** The integration that asked, by the name the person gave it. */
  source: z.string().max(200),
  message: z.string().max(TOOL_QUESTION_MESSAGE_MAX),
  fields: z.array(ToolQuestionFieldSchema).max(TOOL_QUESTION_FIELDS_MAX),
});
export type ToolQuestion = z.infer<typeof ToolQuestionSchema>;

export const ToolQuestionValueSchema = z.union([
  z.string().max(TOOL_QUESTION_TEXT_MAX),
  z.number(),
  z.boolean(),
]);
export type ToolQuestionValue = z.infer<typeof ToolQuestionValueSchema>;

/** What the person did: sent the form, said no, or (`cancel`) never answered. */
export type ToolQuestionAnswer =
  | { action: "accept"; values: Record<string, ToolQuestionValue> }
  | { action: "decline" }
  | { action: "cancel" };

/**
 * The values a person sent, checked against the form: every required field present, each value
 * of its field's type and within its bounds, nothing the form did not ask for. Returns the
 * values to send, or a reason the answer is refused.
 */
export function checkToolQuestionValues(
  fields: readonly ToolQuestionField[],
  values: Record<string, unknown>,
): { ok: true; values: Record<string, ToolQuestionValue> } | { ok: false; reason: string } {
  const out: Record<string, ToolQuestionValue> = {};
  const known = new Set(fields.map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) return { ok: false, reason: `Unknown field ${name}` };
  }
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === null || value === "") {
      if (field.required) return { ok: false, reason: `${field.label || field.name} is required` };
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) return { ok: false, reason: `${field.label || field.name}: ${problem}` };
    out[field.name] = value as ToolQuestionValue;
  }
  return { ok: true, values: out };
}

function fieldProblem(field: ToolQuestionField, value: unknown): string | undefined {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return "expected text";
      if (value.length > field.maxLength) return "too long";
      if (field.minLength !== undefined && value.length < field.minLength) return "too short";
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (field.integer && !Number.isInteger(value)) return "expected a whole number";
      if (field.minimum !== undefined && value < field.minimum) return "too small";
      if (field.maximum !== undefined && value > field.maximum) return "too large";
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected yes or no";
    case "choice":
      return typeof value === "string" && field.options.some((option) => option.value === value)
        ? undefined
        : "not one of the options";
  }
}

/**
 * What a form starts with on every client: the server's defaults, a yes/no field off, and a
 * choice on its first option when the server named none.
 */
export function toolQuestionInitialValues(
  fields: readonly ToolQuestionField[],
): Record<string, ToolQuestionValue | undefined> {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === "boolean"
        ? (field.default ?? false)
        : field.type === "choice"
          ? (field.default ?? field.options[0]?.value)
          : field.default,
    ]),
  );
}

/** The values to send: fields left empty are left out. */
export function toolQuestionSentValues(
  values: Record<string, ToolQuestionValue | undefined>,
): Record<string, ToolQuestionValue> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, ToolQuestionValue] => entry[1] !== undefined && entry[1] !== "",
    ),
  );
}
