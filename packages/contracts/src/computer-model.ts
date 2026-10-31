import { z } from "zod";
import { ThinkingLevelSchema } from "./domain.js";
import { SettingsScopeSchema } from "./settings-scope.js";

export const ComputerModelChoiceSchema = z.object({
  mode: z.literal("model"),
  provider: z.string().min(1).max(80),
  modelId: z.string().min(1).max(300),
  credentialId: z.string().min(1),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
});
/** null inherits the connection default; main explicitly suppresses it on a bot. */
export const ComputerModelSelectionSchema = z
  .union([z.object({ mode: z.literal("main") }), ComputerModelChoiceSchema])
  .nullable();
export const ComputerModelTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection"),
    // The source connection whose computer default is being edited, not the target account.
    credentialId: z.string().min(1),
    scope: SettingsScopeSchema.optional(),
  }),
  z.object({ kind: z.literal("bot"), botId: z.string().min(1) }),
]);
export const ComputerModelViewSchema = z.object({
  selection: ComputerModelSelectionSchema,
  options: z.array(
    ComputerModelChoiceSchema.extend({
      label: z.string(),
      thinkingLevels: z.array(ThinkingLevelSchema),
    }),
  ),
});
export type ComputerModelSelection = z.infer<typeof ComputerModelSelectionSchema>;
export type ComputerModelTarget = z.infer<typeof ComputerModelTargetSchema>;
export type ComputerModelView = z.infer<typeof ComputerModelViewSchema>;
