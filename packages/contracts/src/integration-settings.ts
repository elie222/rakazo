import * as z from "zod";

/**
 * An integration provider's id. Opaque here: the adapters own the list of providers and check an
 * id against it.
 */
export const IntegrationProviderIdSchema = z.string().min(1).max(64);
export type IntegrationProviderId = z.infer<typeof IntegrationProviderIdSchema>;
/** A provider and the credentials its adapter asks for; the adapter checks them. */
export const IntegrationProviderConfigSchema = z
  .object({ provider: IntegrationProviderIdSchema })
  .catchall(z.string().trim().max(16384));
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export const IntegrationSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  needsSetup: z.boolean(),
  webUrl: z.string().url(),
  providers: z.array(z.object({ id: IntegrationProviderIdSchema, configured: z.boolean() })),
});
