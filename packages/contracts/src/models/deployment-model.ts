import * as z from "zod";

/**
 * The model members without their own run on, as an admin sees it. Keys never come back: only
 * whether one is saved. Null `provider` means the environment's model applies.
 */
export const DeploymentModelSettingsSchema = z.object({
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  keySaved: z.boolean(),
  /** Providers an admin can connect with a key, and their models; empty where none can be. */
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      models: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
});
export type DeploymentModelSettings = z.infer<typeof DeploymentModelSettingsSchema>;

/** A null provider goes back to the environment's model and removes the saved key. */
export const DeploymentModelUpdateSchema = z.union([
  z.object({ provider: z.null() }),
  z.object({
    provider: z.string().trim().min(1).max(64),
    modelId: z.string().trim().min(1).max(256),
    /** Left out to keep the saved key, which only the same provider can. */
    apiKey: z.string().trim().min(1).max(4096).optional(),
  }),
]);
export type DeploymentModelUpdate = z.infer<typeof DeploymentModelUpdateSchema>;
