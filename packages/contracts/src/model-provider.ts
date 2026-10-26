/** A provider refused the API key while a connection was being verified. */
export const MODEL_KEY_REJECTED_ERROR = "API key was rejected by the provider.";

/** Resolve saved provider IDs after the Pi catalog's Azure rename. */
export function canonicalPiProviderId(provider: string): string {
  return provider === "azure-openai-responses" ? "azure" : provider;
}

/** IDs that may already own credentials for this provider in storage. */
export function storedPiProviderIds(provider: string): string[] {
  const canonical = canonicalPiProviderId(provider);
  return canonical === "azure" ? ["azure", "azure-openai-responses"] : [provider];
}
