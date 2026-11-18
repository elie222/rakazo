import type { ProviderSettingsField } from "@rakazo/contracts";
import { trimEndChars } from "@rakazo/contracts";

type Values = Record<string, string>;

/** Why a field's value cannot be saved; `message` is the field's own wording when it has one. */
export interface SettingsFieldProblem {
  rule: "required" | "choice" | "length" | "check";
  message?: string;
}

function listItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A field's value as it is saved: trimmed, a choice falling back to its default, a list tidied. */
export function settingsFieldValue(field: ProviderSettingsField, values: Values): string {
  const raw = values[field.key] ?? "";
  if (field.kind === "select") {
    return field.options?.some((option) => option.value === raw) ? raw : (field.default ?? "");
  }
  if (field.kind === "toggle") {
    return raw === "true" || raw === "false" ? raw : (field.default ?? "false");
  }
  if (field.kind === "list") return listItems(raw).join(",");
  return raw.trim();
}

function shown(
  field: ProviderSettingsField,
  fields: readonly ProviderSettingsField[],
  values: Values,
) {
  const when = field.visibleWhen;
  if (!when) return true;
  const controller = fields.find((candidate) => candidate.key === when.key);
  const value = controller
    ? settingsFieldValue(controller, values)
    : (values[when.key] ?? "").trim();
  return when.equals === undefined ? value !== "" : value === when.equals;
}

/** The fields these values call for, in the order the form shows them. */
export function visibleSettingsFields(
  fields: readonly ProviderSettingsField[],
  values: Values,
): ProviderSettingsField[] {
  return fields.filter((field) => shown(field, fields, values));
}

/**
 * What a form starts with: each saved setting its field still applies to, and otherwise the
 * field's default. Secrets start empty, since a saved one is never sent back.
 */
export function initialSettingsValues(
  fields: readonly ProviderSettingsField[],
  saved: Values = {},
): Values {
  const values: Values = {};
  for (const field of fields) {
    if (field.kind === "secret") continue;
    const applies = shown(field, fields, saved);
    if (applies || values[field.key] === undefined) {
      values[field.key] = settingsFieldValue(field, applies ? saved : {});
    }
  }
  return values;
}

/**
 * Checks one field. With `keepsSecrets`, a required secret left empty passes, because the saved
 * one is used.
 */
export function settingsFieldProblem(
  field: ProviderSettingsField,
  values: Values,
  keepsSecrets = false,
): SettingsFieldProblem | null {
  const raw = values[field.key] ?? "";
  if (field.kind === "select" || field.kind === "toggle") {
    const allowed =
      field.kind === "toggle"
        ? ["true", "false"]
        : (field.options ?? []).map((option) => option.value);
    if (raw !== "" && !allowed.includes(raw)) return { rule: "choice" };
  }
  const value = settingsFieldValue(field, values);
  if (!value) {
    if (!field.required || (field.kind === "secret" && keepsSecrets)) return null;
    return { rule: "required", message: field.requiredMessage };
  }
  if (
    (field.minLength !== undefined && value.length < field.minLength) ||
    (field.maxLength !== undefined && value.length > field.maxLength)
  ) {
    return { rule: "length" };
  }
  const failed = field.checks?.find((check) => !new RegExp(check.pattern).test(value));
  return failed ? { rule: "check", message: failed.message } : null;
}

function scopeValue(
  field: ProviderSettingsField,
  fields: readonly ProviderSettingsField[],
  values: Values,
): string {
  if (!shown(field, fields, values)) return "";
  const value = settingsFieldValue(field, values);
  // Clients drop trailing slashes, so they name the same server.
  if (field.kind === "url") return trimEndChars(value, "/");
  if (field.kind === "list") return [...new Set(listItems(value))].sort().join(",");
  return value;
}

/** Whether the saved secrets still apply: nothing they can reach differs from the saved settings. */
export function keepsSavedSecrets(
  fields: readonly ProviderSettingsField[],
  values: Values,
  saved: Values | undefined,
): boolean {
  if (!saved) return false;
  return fields
    .filter((field) => field.scopesSecrets)
    .every((field) => scopeValue(field, fields, values) === scopeValue(field, fields, saved));
}

/**
 * Whether the form can be sent. A field with its own message for being left empty never holds
 * the form back: the form shows that message when it is sent instead.
 */
export function settingsFormReady(
  fields: readonly ProviderSettingsField[],
  values: Values,
  saved: Values | undefined,
): boolean {
  const keepsSecrets = keepsSavedSecrets(fields, values, saved);
  return visibleSettingsFields(fields, values).every((field) => {
    const problem = settingsFieldProblem(field, values, keepsSecrets);
    return !problem || (problem.rule === "required" && field.requiredMessage !== undefined);
  });
}

/** What a form sends: the visible fields that hold a value, secrets apart from settings. */
export function settingsSubmission(
  fields: readonly ProviderSettingsField[],
  values: Values,
): { settings: Values; credentials: Values } {
  const settings: Values = {};
  const credentials: Values = {};
  for (const field of visibleSettingsFields(fields, values)) {
    const value = settingsFieldValue(field, values);
    if (value) (field.kind === "secret" ? credentials : settings)[field.key] = value;
  }
  return { settings, credentials };
}
