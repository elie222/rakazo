import type { ModelCatalogEntry } from "@rakazo/contracts";

export const POPULAR_MODEL_PROVIDER_IDS = [
  "openrouter",
  "openai-codex",
  "anthropic",
  "openai",
  "google",
  "vercel-ai-gateway",
] as const;

const DEFAULT_PROVIDER_COUNT = POPULAR_MODEL_PROVIDER_IDS.length;
const POPULAR_MODEL_PROVIDER_ID_SET = new Set<string>(POPULAR_MODEL_PROVIDER_IDS);

/** Keep onboarding short while ensuring a deployment's current default is never hidden. */
export function featuredModelProviders(
  providers: readonly ModelCatalogEntry[],
  selectedProvider: string,
): ModelCatalogEntry[] {
  const byId = new Map(providers.map((entry) => [entry.provider, entry]));
  const ordered = [
    ...POPULAR_MODEL_PROVIDER_IDS.map((id) => byId.get(id)).filter(
      (entry): entry is ModelCatalogEntry => entry !== undefined,
    ),
    ...providers.filter((entry) => !POPULAR_MODEL_PROVIDER_ID_SET.has(entry.provider)),
  ];
  const featured = ordered.slice(0, DEFAULT_PROVIDER_COUNT);
  const selected = byId.get(selectedProvider);

  if (!selected || featured.some((entry) => entry.provider === selectedProvider)) return featured;
  return [...featured.slice(0, DEFAULT_PROVIDER_COUNT - 1), selected];
}

/** Return the active choice separately when it is not one of the search results. */
export function selectedProviderOutsideSearchResults(
  filteredProviders: readonly ModelCatalogEntry[],
  allProviders: readonly ModelCatalogEntry[],
  selectedProvider: string,
): ModelCatalogEntry | undefined {
  if (filteredProviders.some((entry) => entry.provider === selectedProvider)) {
    return undefined;
  }
  return allProviders.find((entry) => entry.provider === selectedProvider);
}
