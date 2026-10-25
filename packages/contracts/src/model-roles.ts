import { z } from "zod";
import type { ModelCatalogEntry } from "./domain.js";
import { ModelBackupChoiceSchema, modelChoiceListSchema, ThinkingLevelSchema } from "./domain.js";

/** Add purposes here; connections, persistence, pickers and backups stay shared. */
export const ModelRoleSchema = z.enum(["main", "approval"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const ModelRoleChoiceSchema = ModelBackupChoiceSchema.extend({
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
});
export type ModelRoleChoice = z.infer<typeof ModelRoleChoiceSchema>;
export const ModelRoleSettingsSchema = z.object({
  primary: ModelRoleChoiceSchema.nullable(),
  backups: modelChoiceListSchema(ModelRoleChoiceSchema),
});
export type ModelRoleSettings = z.infer<typeof ModelRoleSettingsSchema>;
export const ModelRoleUpdateSchema = ModelRoleSettingsSchema.partial();

export function modelSupportsRole(entry: ModelCatalogEntry, role: ModelRole): boolean {
  return role === "approval" || entry.protocol !== "decisions";
}
