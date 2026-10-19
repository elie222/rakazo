import type { ModelCatalogEntry } from "@rakazo/contracts";
import { matchesSearchQuery } from "./search.js";

/** Effort choices an OpenAI-compatible endpoint stores when reasoning is enabled. */
export const COMPATIBLE_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const THINKING_LEVELS = ["off", ...COMPATIBLE_THINKING_LEVELS] as const;

/**
 * Map a staged effort onto the levels a model actually supports.
 * An exact match is kept. Otherwise the nearest supported effort is used
 * (higher first, then lower). Models that cannot think, and the "off" level,
 * reset to null so the runtime default applies.
 * `supported === undefined` means the model is outside the catalog: a concrete
 * level is kept because there is no allowance list to clamp against.
 */
export function clampCatalogThinkingLevel(
  level: string | null | undefined,
  supported: readonly string[] | undefined,
): string | null {
  if (!level || level === "off") return null;
  if (supported === undefined) return level;
  const available = supported.filter((entry) => entry !== "off");
  if (available.length === 0) return null;
  if (available.includes(level)) return level;
  const requestedIndex = THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]);
  if (requestedIndex === -1) return null;
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index++) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && candidate !== "off" && available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index--) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && candidate !== "off" && available.includes(candidate)) return candidate;
  }
  return null;
}

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

/** Keep provider selection short while ensuring a deployment's current default is never hidden. */
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

/**
 * Model to preselect when a provider row is opened: the preferred id (usually the
 * space or deployment default) when that provider carries it, otherwise the
 * provider's first catalog entry.
 *
 * Aggregator providers prefix ids with the upstream vendor ("openai/gpt-6-luna"
 * on OpenRouter) while first-party providers expose the same model unprefixed
 * ("gpt-6-luna" on OpenAI Codex), so the preferred id's basename is tried after
 * the exact id. This is only a preselection — the user still confirms the pick.
 */
export function pickCatalogModelId(
  catalog: readonly { provider: string; id: string }[],
  provider: string,
  preferredId?: string | null,
): string {
  const entries = catalog.filter((entry) => entry.provider === provider);
  if (preferredId) {
    if (entries.some((entry) => entry.id === preferredId)) return preferredId;
    const basename = preferredId.split("/").at(-1);
    if (basename && basename !== preferredId) {
      const shared = entries.find((entry) => entry.id === basename);
      if (shared) return shared.id;
    }
  }
  return entries[0]?.id ?? "";
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

/**
 * Display forms the DeepSeek API rejects. The selectable id stays the API model
 * id (`deepseek-flash`, `deepseek-v4-pro`); the catalog label can stay human-readable.
 */
const DEEPSEEK_DISPLAY_MODEL_IDS: Record<string, string> = {
  deepseekv41flash: "deepseek-flash",
  deepseekv4pro: "deepseek-v4-pro",
};

export type ConnectedModelChoice = {
  key: string;
  provider: string;
  modelId: string;
  label: string;
};

type CatalogModelRef = {
  provider: string;
  id: string;
  label: string;
  providerName?: string;
  placeholder?: boolean;
};

type CredentialModelRef = {
  provider: string;
  label: string;
  modelId?: string | null;
};

function modelToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** API id for a known DeepSeek display label, when it differs from `modelId`. */
function canonicalApiModelId(provider: string, modelId: string): string | undefined {
  if (provider !== "deepseek") return undefined;
  const canonical = DEEPSEEK_DISPLAY_MODEL_IDS[modelToken(modelId)];
  if (!canonical || canonical === modelId) return undefined;
  return canonical;
}

export function modelOptionKey(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

export function parseModelOptionKey(key: string): { provider: string; modelId: string } | null {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  return { provider: key.slice(0, separator), modelId: key.slice(separator + 2) };
}

/**
 * Model id safe to submit. Catalog ids pass through. A display label such as
 * "DeepSeek-V4.1-Flash" resolves to the API id the catalog actually calls.
 * An id the catalog does not know stays unchanged so a custom model still works.
 */
export function resolveSelectableModelId(
  catalog: readonly CatalogModelRef[],
  provider: string,
  modelId: string,
): string {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const canonical = canonicalApiModelId(provider, trimmed);
  if (canonical) return canonical;
  const entries = catalog.filter((entry) => entry.provider === provider && !entry.placeholder);
  if (entries.some((entry) => entry.id === trimmed)) return trimmed;
  const token = modelToken(trimmed);
  const byId = entries.filter((entry) => modelToken(entry.id) === token);
  if (byId.length === 1 && byId[0]) return byId[0].id;
  const byLabel = entries.filter(
    (entry) => modelToken(entry.label) === token && modelToken(entry.id) !== token,
  );
  if (byLabel.length === 1 && byLabel[0]) return byLabel[0].id;
  return trimmed;
}

/**
 * Models a connected provider can run. Catalog entries submit their API ids.
 * A saved display label expands to those ids instead of becoming the only choice.
 * A custom id that is not a catalog label stays a single free-form option.
 */
export function connectedModelChoices(
  credentials: readonly CredentialModelRef[],
  catalog: readonly CatalogModelRef[],
): ConnectedModelChoice[] {
  const choices: ConnectedModelChoice[] = [];
  const seen = new Set<string>();
  for (const credential of credentials) {
    const providerModels = catalog.filter(
      (entry) => entry.provider === credential.provider && !entry.placeholder,
    );
    const raw = credential.modelId?.trim() ?? "";
    const resolved = raw ? resolveSelectableModelId(providerModels, credential.provider, raw) : "";
    const resolvedInCatalog = providerModels.some(
      (entry) => resolveSelectableModelId(providerModels, entry.provider, entry.id) === resolved,
    );
    const next: ConnectedModelChoice[] =
      raw && !resolvedInCatalog
        ? [
            {
              key: modelOptionKey(credential.provider, resolved || raw),
              provider: credential.provider,
              modelId: resolved || raw,
              label: `${credential.label} · ${resolved || raw}`,
            },
          ]
        : providerModels.map((entry) => {
            const modelId = resolveSelectableModelId(providerModels, entry.provider, entry.id);
            return {
              key: modelOptionKey(entry.provider, modelId),
              provider: entry.provider,
              modelId,
              label: `${entry.providerName ?? entry.provider} · ${entry.label}`,
            };
          });
    for (const choice of next) {
      if (seen.has(choice.key)) continue;
      seen.add(choice.key);
      choices.push(choice);
    }
  }
  return choices;
}

/** Match a model by name, id, or provider name; a blank query keeps every model. */
export function filterModelCatalog(
  entries: readonly ModelCatalogEntry[],
  query: string,
): readonly ModelCatalogEntry[] {
  if (!query.trim()) return entries;
  return entries.filter((entry) =>
    matchesSearchQuery(query, entry.label, entry.id, entry.providerName ?? entry.provider),
  );
}
