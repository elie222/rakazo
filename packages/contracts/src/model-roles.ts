import { z } from "zod";
import type { ModelCatalogEntry } from "./domain.js";
import { ModelBackupChoiceSchema, modelChoiceListSchema } from "./domain.js";
import { Id, ThinkingLevelSchema } from "./ids.js";

/** Add purposes here; connections, persistence, pickers and backups stay shared. */
export const ModelRoleSchema = z.enum(["main", "approval"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const ModelRoleChoiceSchema = ModelBackupChoiceSchema.extend({
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  /** The connection this row runs on; omitted rows use the provider's connection or the deployment's. */
  credentialId: Id.optional(),
});
export type ModelRoleChoice = z.infer<typeof ModelRoleChoiceSchema>;
export const ModelRoleSettingsSchema = z.object({
  primary: ModelRoleChoiceSchema.nullable(),
  backups: modelChoiceListSchema(ModelRoleChoiceSchema),
});
export type ModelRoleSettings = z.infer<typeof ModelRoleSettingsSchema>;
export const ModelRoleUpdateSchema = ModelRoleSettingsSchema.partial();
/** A member's choices plus what the deployment runs when they chose no model. */
export const ModelRoleViewSchema = ModelRoleSettingsSchema.extend({
  deploymentPrimary: ModelRoleChoiceSchema.nullable().optional(),
});
export type ModelRoleView = z.infer<typeof ModelRoleViewSchema>;

export function modelSupportsRole(entry: ModelCatalogEntry, role: ModelRole): boolean {
  return role === "approval" || entry.protocol !== "decisions";
}
