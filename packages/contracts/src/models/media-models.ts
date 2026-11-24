import { z } from "zod";
import { Id } from "../ids.js";

/** Which media a chosen model makes; stored beside the model roles, one choice each. */
export const MediaModelRoleSchema = z.enum(["image", "video"]);
export type MediaModelRole = z.infer<typeof MediaModelRoleSchema>;

export const MediaModelChoiceSchema = z.object({
  credentialId: Id,
  modelId: z.string().min(1).max(200),
});
export type MediaModelChoice = z.infer<typeof MediaModelChoiceSchema>;

/** A model one connection makes; `provider` and `modelId` are how its usage is recorded. */
export const MediaModelOptionSchema = MediaModelChoiceSchema.extend({
  label: z.string(),
  provider: z.string(),
  connectionLabel: z.string(),
});
export type MediaModelOption = z.infer<typeof MediaModelOptionSchema>;

/**
 * The models the member's own connections offer for one kind of media, and the one bots use:
 * the chosen one, else the newest connection's default. No options means the deployment's.
 */
export const MediaModelRoleViewSchema = z.object({
  options: z.array(MediaModelOptionSchema),
  selected: MediaModelChoiceSchema.nullable(),
});
export type MediaModelRoleView = z.infer<typeof MediaModelRoleViewSchema>;

export const MediaModelsViewSchema = z.object({
  image: MediaModelRoleViewSchema,
  video: MediaModelRoleViewSchema,
});
export type MediaModelsView = z.infer<typeof MediaModelsViewSchema>;
