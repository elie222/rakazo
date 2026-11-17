import * as z from "zod";

/**
 * One field of a provider's settings form. Public metadata only; adapter validation and
 * constructor options stay server-side. Every value is a string: a toggle is "true" or "false",
 * and a list is comma-separated names whose order and repeats do not matter.
 */
export const ProviderSettingsFieldSchema = z.object({
  /** Two fields may share a key when `visibleWhen` shows only one of them at a time. */
  key: z.string(),
  label: z.string(),
  kind: z.enum(["text", "secret", "url", "select", "toggle", "list"]),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  validation: z.enum(["public-https"]).optional(),
  /** A saved credential must be re-entered when its destination changes. */
  destination: z.string().optional(),
  /** What a select or toggle holds until it is changed. */
  default: z.string().optional(),
  /** An example of the value, never a default. */
  placeholder: z.string().optional(),
  description: z.string().optional(),
  /** Kept out of sight until the form's advanced section is opened. */
  advanced: z.boolean().optional(),
  /** Shown while another field holds this value, or any value when none is named. */
  visibleWhen: z.object({ key: z.string(), equals: z.string().optional() }).optional(),
  minLength: z.number().int().positive().optional(),
  maxLength: z.number().int().positive().optional(),
  /** Patterns the trimmed value must match; the first that fails gives its message. */
  checks: z.array(z.object({ pattern: z.string(), message: z.string() })).optional(),
  /** Shown when the form is submitted without this required field, which then never blocks submitting. */
  requiredMessage: z.string().optional(),
  /** Saved secrets reach only what this field names, so changing it means entering them again. */
  scopesSecrets: z.boolean().optional(),
});
export type ProviderSettingsField = z.infer<typeof ProviderSettingsFieldSchema>;

export const MemoryProviderDescriptorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  fields: z.array(ProviderSettingsFieldSchema),
});
export type MemoryProviderDescriptor = z.infer<typeof MemoryProviderDescriptorSchema>;
