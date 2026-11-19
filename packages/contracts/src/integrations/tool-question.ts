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
  // Entries, not assignment: a field may be named like an object's own internals (`__proto__`).
  const out: Array<[string, ToolQuestionValue]> = [];
  const known = new Set(fields.map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) return { ok: false, reason: `Unknown field ${name}` };
  }
  for (const field of fields) {
    // Own values only: a field named like an object built-in (`toString`) is empty when unset.
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
    if (value === undefined || value === null || value === "") {
      if (field.required) return { ok: false, reason: `${field.label || field.name} is required` };
      continue;
    }
    const problem = fieldProblem(field, value);
    if (problem) return { ok: false, reason: `${field.label || field.name}: ${problem}` };
    out.push([field.name, value as ToolQuestionValue]);
  }
  return { ok: true, values: Object.fromEntries(out) };
}

/** The JSON Schema formats a form may name, checked as the server will read them. */
const FORMATS: Record<"email" | "uri" | "date" | "date-time", (value: string) => boolean> = {
  email: (value) => /^[^\s@]+@[^\s@]+$/.test(value),
  uri: (value) => URL.canParse(value),
  date: (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = new Date(`${value}T00:00:00Z`);
    // An impossible month or day either fails to parse or rolls over to another date.
    return !Number.isNaN(time.getTime()) && time.toISOString().startsWith(value);
  },
  "date-time": (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    FORMATS.date(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value)),
};

function fieldProblem(field: ToolQuestionField, value: unknown): string | undefined {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return "expected text";
      if (value.length > field.maxLength) return "too long";
      if (field.minLength !== undefined && value.length < field.minLength) return "too short";
      return field.format && !FORMATS[field.format](value)
        ? `not a valid ${field.format}`
        : undefined;
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

/** A form as a client holds it while the person types: numbers stay text until sent. */
export type ToolQuestionDraft = Record<string, string | boolean | undefined>;

/**
 * What a form starts with on every client: the server's defaults. A required yes/no field starts
 * off and a required choice on its first option; an optional one the server gave no default
 * starts unset, so an untouched form sends nothing for it.
 */
export function toolQuestionInitialDraft(fields: readonly ToolQuestionField[]): ToolQuestionDraft {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === "boolean"
        ? (field.default ?? (field.required ? false : undefined))
        : field.type === "choice"
          ? (field.default ?? (field.required ? field.options[0]?.value : undefined))
          : field.default === undefined
            ? undefined
            : String(field.default),
    ]),
  );
}

/**
 * The values to send: empty fields left out, numbers parsed, and a date-time as RFC 3339 with
 * its offset. Text that does not parse is sent as typed, so the server names the field.
 */
export function toolQuestionSentValues(
  fields: readonly ToolQuestionField[],
  draft: ToolQuestionDraft,
): Record<string, ToolQuestionValue> {
  const out: Array<[string, ToolQuestionValue]> = [];
  for (const field of fields) {
    const value = draft[field.name];
    if (value === undefined || value === "") continue;
    if (typeof value === "string" && field.type === "number") {
      // A comma-decimal keyboard types 1,5: one comma and no point reads as the decimal mark.
      const typed = value.trim();
      const number = Number(/^-?\d*,\d+$/.test(typed) ? typed.replace(",", ".") : typed);
      out.push([field.name, value.trim() !== "" && Number.isFinite(number) ? number : value]);
    } else if (typeof value === "string" && field.type === "text" && field.format === "date-time") {
      const time = new Date(value);
      out.push([field.name, Number.isNaN(time.getTime()) ? value : time.toISOString()]);
    } else out.push([field.name, value]);
  }
  return Object.fromEntries(out);
}

/** What a card shows: its stored status, or the answer this client just sent until it lands. */
export function toolQuestionShownStatus(
  status: "pending" | "accepted" | "declined" | "expired",
  sent: "accept" | "decline" | undefined,
): "pending" | "accepted" | "declined" | "expired" {
  if (status !== "pending" || !sent) return status;
  return sent === "accept" ? "accepted" : "declined";
}
