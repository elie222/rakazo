/**
 * Provider capabilities the shared catalogue code has to know about without naming any provider.
 * An adapter declares its own traits while registering, so shared modules ask a question instead of
 * comparing a provider id, which keeps vendor knowledge inside the adapter that owns it.
 */
const catalogProbeDisabled = new Set<string>();

/**
 * Marks a provider whose catalogue cannot be probed: a model list fetched from one endpoint would
 * be recorded as models served by that endpoint, including ids it does not serve that way.
 */
export function disableCatalogProbe(providerId: string): void {
  catalogProbeDisabled.add(providerId);
}

export function isCatalogProbeDisabled(providerId: string): boolean {
  return catalogProbeDisabled.has(providerId);
}
