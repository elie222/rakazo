import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";

export type ConnectedModelOption = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
};

export function modelOptionKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

export function parseModelOptionKey(key: string) {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  const provider = key.slice(0, separator);
  const modelId = key.slice(separator + 2);
  if (!modelId) return null;
  return { provider, modelId };
}

export function modelCatalogLabel(
  catalog: readonly ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
) {
  if (!provider || !modelId) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}

/** Models that can be selected without asking the user to connect another provider. */
export function connectedModelOptions(
  credentials: readonly ModelCredential[],
  catalog: readonly ModelCatalogEntry[],
): ConnectedModelOption[] {
  const result: ConnectedModelOption[] = [];
  const seen = new Set<string>();

  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const credentialInCatalog = Boolean(
      credential.modelId && providerModels.some((entry) => entry.id === credential.modelId),
    );
    const options =
      credential.modelId && !credentialInCatalog
        ? [
            {
              key: modelOptionKey(credential.provider, credential.modelId),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelOptionKey(entry.provider, entry.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
          }));

    for (const option of options) {
      if (seen.has(option.key)) continue;
      seen.add(option.key);
      result.push(option);
    }
  }

  return result;
}
