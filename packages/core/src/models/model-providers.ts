import type { Bot, ModelApiProtocol, ModelCatalogEntry, ModelSettings } from "@rakazo/contracts";
import {
  canonicalPiProviderId,
  modelConnectionNames,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  selectCompatibleModelCredential,
  withConnectionName,
} from "@rakazo/contracts";
import { listSearch } from "../primitives/list-search.js";

/** Bots that pick their own model ignore the space default and its changes. */
export function botsWithOwnModel<T extends Pick<Bot, "modelProvider" | "modelId">>(
  bots: readonly T[],
): T[] {
  return bots.filter((bot) => Boolean(bot.modelProvider && bot.modelId));
}

/** Effort choices an OpenAI-compatible endpoint stores when reasoning is enabled. */
export const COMPATIBLE_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Effort choices by wire protocol. Anthropic Messages maps every level to a
 * budget, and pi-ai's budgets top out at the "high" level, so the two levels
 * above it are not offered for that protocol.
 */
export function compatibleThinkingLevels(
  apiProtocol: ModelApiProtocol | undefined,
): readonly (typeof COMPATIBLE_THINKING_LEVELS)[number][] {
  return apiProtocol === "anthropic-messages"
    ? COMPATIBLE_THINKING_LEVELS.filter((level) => level !== "xhigh" && level !== "max")
    : COMPATIBLE_THINKING_LEVELS;
}

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

/** The subscriptions a person can sign in with instead of pasting an API key, as they know them. */
export const MODEL_SUBSCRIPTION_NAMES = ["ChatGPT", "Claude"] as const;

export const POPULAR_MODEL_PROVIDER_IDS = [
  "openai-codex",
  "anthropic",
  "openai",
  "openrouter",
  "google",
] as const;

const DEFAULT_PROVIDER_COUNT = POPULAR_MODEL_PROVIDER_IDS.length;
const POPULAR_MODEL_PROVIDER_IDS_LIST: readonly string[] = POPULAR_MODEL_PROVIDER_IDS;

/** Popular providers in curated order, then the rest by name. */
export function popularModelProvidersFirst<T>(
  items: readonly T[],
  providerId: (item: T) => string,
  name: (item: T) => string,
): T[] {
  const rank = (item: T) => {
    const index = POPULAR_MODEL_PROVIDER_IDS_LIST.indexOf(providerId(item));
    return index === -1 ? DEFAULT_PROVIDER_COUNT : index;
  };
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || name(a).localeCompare(name(b), undefined, { sensitivity: "base" }),
  );
}

/**
 * Model to preselect when a provider row is opened: the saved/preferred id
 * when that provider carries it, otherwise its recommended model, then its
 * first catalog entry.
 *
 * Aggregator providers prefix ids with the upstream vendor ("openai/gpt-6-luna"
 * on OpenRouter) while first-party providers expose the same model unprefixed
 * ("gpt-6-luna" on OpenAI Codex), so the preferred id's basename is tried after
 * the exact id. This is only a preselection — the user still confirms the pick.
 */
export function pickCatalogModelId(
  catalog: readonly { provider: string; id: string; recommended?: boolean }[],
  provider: string,
  preferredId?: string | null,
): string {
  const entries = catalog.filter(
    (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider),
  );
  if (preferredId) {
    if (entries.some((entry) => entry.id === preferredId)) return preferredId;
    const basename = preferredId.split("/").at(-1);
    if (basename && basename !== preferredId) {
      const shared = entries.find((entry) => entry.id === basename);
      if (shared) return shared.id;
    }
  }
  return entries.find((entry) => entry.recommended)?.id ?? entries[0]?.id ?? "";
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
  preserveModelOrder?: boolean;
  key: string;
  provider: string;
  modelId: string;
  label: string;
  providerLabel?: string;
  modelLabel?: string;
  /** The catalog says whether the model reads images; unknown for free-form ids. */
  images?: boolean;
};

type CatalogModelRef = {
  managed?: boolean;
  provider: string;
  id: string;
  label: string;
  providerName?: string;
  subscriptionName?: string;
  auth?: ModelCatalogEntry["auth"];
  placeholder?: boolean;
  images?: boolean;
};

type CredentialModelRef = {
  preserveModelOrder?: boolean;
  id?: string;
  authKind?: string;
  provider: string;
  label: string;
  modelId?: string | null;
  enabledModelIds?: readonly string[] | null;
  modelSettings?: Readonly<Record<string, ModelSettings>>;
  /** The enabled compatible models that read images, as the server runs them. */
  visionModelIds?: readonly string[];
  isDefault?: boolean;
  preferenceRank?: number;
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
  return `${canonicalPiProviderId(provider)}::${modelId}`;
}

export function parseModelOptionKey(key: string): { provider: string; modelId: string } | null {
  const separator = key.indexOf("::");
  if (separator <= 0) return null;
  const modelId = key.slice(separator + 2);
  if (!modelId) return null;
  return {
    provider: canonicalPiProviderId(key.slice(0, separator)),
    modelId,
  };
}

export const FAVORITES_SECTION_KEY = "favorites";

/** Canonicalizes and deduplicates starred `provider::modelId` keys while keeping their order. */
export function normalizeStarredModelKeys(keys: readonly string[] | undefined): string[] {
  if (!keys?.length) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of keys) {
    const parsed = parseModelOptionKey(raw.trim());
    if (!parsed) continue;
    const key = modelOptionKey(parsed.provider, parsed.modelId);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

/** Adds or removes one `provider::modelId` key idempotently, preserving existing order. */
export function applyStarredModelToggle(
  keys: readonly string[] | undefined,
  key: string,
  starred: boolean,
): string[] {
  const normalized = normalizeStarredModelKeys(keys);
  const parsed = parseModelOptionKey(key.trim());
  if (!parsed) return normalized;
  const target = modelOptionKey(parsed.provider, parsed.modelId);
  if (starred) return normalized.includes(target) ? normalized : [...normalized, target];
  return normalized.filter((entry) => entry !== target);
}

/** Toggles one `provider::modelId` key in the starred list, appending newly starred models. */
export function toggleStarredModelKey(keys: readonly string[] | undefined, key: string): string[] {
  const normalized = normalizeStarredModelKeys(keys);
  const parsed = parseModelOptionKey(key.trim());
  if (!parsed) return normalized;
  const target = modelOptionKey(parsed.provider, parsed.modelId);
  return applyStarredModelToggle(normalized, target, !normalized.includes(target));
}

export type ModelChoiceSection = {
  key: string;
  heading?: string;
  favorites?: boolean;
  data: ChatModelChoice[];
};

/**
 * Prepends a Favorites section for starred models present in `choices`, preserving the user's
 * starred order and omitting starred keys whose provider is disconnected or unavailable.
 */
export function withFavoriteModelChoices<
  S extends { key: string; heading?: string; favorites?: boolean; data: ChatModelChoice[] },
>(
  sections: readonly S[],
  choices: readonly ChatModelChoice[],
  starredKeys: readonly string[] | undefined,
  favoritesHeading: string,
): ((S & { favorites?: boolean }) | (ModelChoiceSection & { collapsed: false }))[] {
  const normalized = normalizeStarredModelKeys(starredKeys);
  if (!normalized.length) return [...sections];
  const byKey = new Map<string, ChatModelChoice>();
  for (const choice of choices) {
    if (!choice.providerLabel) continue;
    const parsed = parseModelOptionKey(choice.key);
    if (!parsed) continue;
    const canonicalKey = modelOptionKey(parsed.provider, parsed.modelId);
    if (!byKey.has(canonicalKey)) byKey.set(canonicalKey, choice);
  }
  const favorites: ChatModelChoice[] = [];
  for (const key of normalized) {
    const choice = byKey.get(key);
    if (!choice) continue;
    const vendor = choice.modelLabel?.match(/^([^:]+): (.+)$/);
    favorites.push({
      ...choice,
      title: choice.title ?? vendor?.[2] ?? choice.modelLabel ?? choice.label,
    });
  }
  if (!favorites.length) return [...sections];
  return [
    {
      key: FAVORITES_SECTION_KEY,
      heading: favoritesHeading,
      favorites: true,
      collapsed: false,
      data: favorites,
    },
    ...sections,
  ];
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
  const entries = catalog.filter(
    (entry) =>
      canonicalPiProviderId(entry.provider) === canonicalPiProviderId(provider) &&
      !entry.placeholder,
  );
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

function freeFormChoice(credential: CredentialModelRef, modelId: string): ConnectedModelChoice {
  return {
    preserveModelOrder: credential.preserveModelOrder,
    key: modelOptionKey(credential.provider, modelId),
    provider: credential.provider,
    modelId,
    label: withConnectionName(modelId, credential.label),
    providerLabel: credential.label,
    modelLabel: modelId,
  };
}

function catalogChoices(
  providerModels: readonly CatalogModelRef[],
  preserveModelOrder?: boolean,
): ConnectedModelChoice[] {
  return providerModels.map((entry) => {
    const modelId = resolveSelectableModelId(providerModels, entry.provider, entry.id);
    return {
      ...(preserveModelOrder ? { preserveModelOrder: true } : {}),
      key: modelOptionKey(entry.provider, modelId),
      provider: entry.provider,
      modelId,
      label: withConnectionName(entry.label, entry.providerName ?? entry.provider),
      providerLabel: entry.providerName ?? entry.provider,
      modelLabel: entry.label,
      images: entry.images,
    };
  });
}

/** The connected credential that runs `modelId`: an enabled id or the connection default. */
export function credentialForModel<C extends CredentialModelRef>(
  credentials: readonly C[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
): C | undefined {
  if (!provider || !modelId) return undefined;
  const candidates = credentials.filter((credential) => credential.provider === provider);
  const preferences = [...candidates].sort(
    (left, right) =>
      Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)) ||
      (left.preferenceRank ?? Infinity) - (right.preferenceRank ?? Infinity),
  );
  const matching = preferences.filter((credential) => credential.modelId === modelId);
  const preferred =
    preferences.find(
      (credential) =>
        credential.isDefault || credential.preferenceRank !== undefined || credential.modelId,
    ) ?? candidates[0];
  const selected = matching.find((credential) => credential.isDefault) ?? matching[0] ?? preferred;
  if (provider !== "openai-compatible")
    return (
      matching[0] ?? candidates.find((credential) => credential.enabledModelIds?.includes(modelId))
    );
  if (!selected) return undefined;
  const refs = candidates.map((credential) => ({
    credential,
    defaultModel: credential.modelId,
    enabledModelIds: credential.enabledModelIds,
  }));
  return selectCompatibleModelCredential(
    refs.find((ref) => ref.credential === selected)!,
    refs,
    modelId,
  )?.credential;
}

/**
 * The connection a model row runs on, in the order runs choose it: its pinned connection, else
 * one whose saved model is this one, else the most preferred connection for its provider.
 */
export function connectionForModelChoice<C extends CredentialModelRef>(
  credentials: readonly C[],
  choice: {
    provider: string;
    modelId: string;
    credentialId?: string | null;
    creditOfferingId?: string | null;
  },
): C | undefined {
  if (choice.creditOfferingId) return undefined;
  if (choice.credentialId) return credentials.find((entry) => entry.id === choice.credentialId);
  const provider = credentials.filter(
    (entry) => canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider),
  );
  const preferred = [...provider].sort(
    (left, right) => (left.preferenceRank ?? Infinity) - (right.preferenceRank ?? Infinity),
  );
  return preferred.find((entry) => entry.modelId === choice.modelId) ?? preferred[0];
}

/**
 * Models a connected provider can run. Catalog entries submit their API ids.
 * A saved display label expands to those ids instead of becoming the only choice.
 * A custom id that is not a catalog label stays a single free-form option.
 * A connection with enabled ids offers one free-form option per id.
 */
export function connectedModelChoices(
  credentials: readonly CredentialModelRef[],
  catalog: readonly CatalogModelRef[],
): ConnectedModelChoice[] {
  const choices: ConnectedModelChoice[] = [];
  const seen = new Set<string>();
  const modelsByProvider = new Map<string, CatalogModelRef[]>();
  for (const entry of catalog) {
    if (entry.placeholder) continue;
    const provider = canonicalPiProviderId(entry.provider);
    const models = modelsByProvider.get(provider) ?? [];
    models.push(entry);
    modelsByProvider.set(provider, models);
  }
  for (const credential of credentials) {
    const providerModels = modelsByProvider.get(canonicalPiProviderId(credential.provider)) ?? [];
    const raw = credential.modelId?.trim() ?? "";
    const resolved = raw ? resolveSelectableModelId(providerModels, credential.provider, raw) : "";
    const resolvedInCatalog = providerModels.some(
      (entry) => resolveSelectableModelId(providerModels, entry.provider, entry.id) === resolved,
    );
    const enabled = (credential.enabledModelIds ?? []).map((id) => id.trim()).filter(Boolean);
    const next: ConnectedModelChoice[] =
      enabled.length > 0
        ? enabled.map((id) => {
            const known = providerModels.find((entry) => entry.id === id)?.images;
            const own = credential.modelSettings?.[id]?.images;
            const served = credential.visionModelIds?.includes(id);
            return {
              ...freeFormChoice(credential, id),
              images:
                credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID
                  ? (served ?? own ?? known)
                  : (known ?? own),
            };
          })
        : raw && !resolvedInCatalog
          ? [freeFormChoice(credential, resolved || raw)]
          : catalogChoices(providerModels, credential.preserveModelOrder);
    choices.push(...next);
  }
  const unique = (choice: ConnectedModelChoice) => {
    if (seen.has(choice.key)) return false;
    seen.add(choice.key);
    return true;
  };
  const connected = choices.filter(unique).map((choice) => {
    const models = modelsByProvider.get(canonicalPiProviderId(choice.provider)) ?? [];
    const exact = models.find((entry) => entry.id === choice.modelId);
    const entry = exact ?? models[0];
    if (!entry?.subscriptionName) return choice;
    const serving = connectionForModelChoice(credentials, choice);
    const { connectionName: providerLabel } = modelConnectionNames(entry, serving);
    return {
      ...choice,
      providerLabel,
      label: withConnectionName(choice.modelLabel ?? choice.modelId, providerLabel),
    };
  });
  return [
    ...connected,
    ...catalogChoices(catalog.filter((entry) => entry.managed && !entry.placeholder)).filter(
      unique,
    ),
  ];
}

export type ChatModelChoice = {
  preserveModelOrder?: boolean;
  key: string;
  label: string;
  provider?: string;
  modelId?: string;
  providerLabel?: string;
  modelLabel?: string;
  title?: string;
  detail?: string;
  images?: boolean;
};

/** Filter on full labels before shortening rows; saved/default choices stay first. */
export function groupModelChoices(choices: readonly ChatModelChoice[], query: string) {
  const sections: { key: string; heading?: string; data: ChatModelChoice[] }[] = [];
  for (const choice of filterModelChoices(choices, query)) {
    // The catalog has no vendor field. Its display convention is "Vendor: Model".
    const vendor = choice.modelLabel?.match(/^([^:]+): (.+)$/);
    const heading = choice.providerLabel
      ? vendor?.[1]
        ? withConnectionName(vendor[1], choice.providerLabel)
        : choice.providerLabel
      : undefined;
    const key = heading ? `provider:${heading}` : "ungrouped";
    let section = sections.find((entry) => entry.key === key);
    if (!section) {
      section = { key, heading, data: [] };
      if (heading) sections.push(section);
      else sections.unshift(section);
    }
    section.data.push({
      ...choice,
      title: choice.title ?? vendor?.[2] ?? choice.modelLabel ?? choice.label,
    });
  }
  for (const section of sections) {
    if (!section.heading) continue;
    const own = section.data.filter((c) => c.preserveModelOrder);
    const others = newestModelsFirst(
      section.data
        .filter((c) => !c.preserveModelOrder)
        .map((choice) => ({ id: choice.modelId ?? "", choice })),
    ).map((entry) => entry.choice);
    section.data = [...others, ...own];
  }
  return sections;
}

/**
 * Splits a section into the newest model of each family and the older ones behind it, keeping
 * the section's order. The selected model and a connection's own ordered models stay in view.
 */
export function latestModelChoices<C extends ChatModelChoice>(
  choices: readonly C[],
  selectedKey: string,
): { latest: C[]; older: C[] } {
  const releases = new Map(
    choices.map((choice) => [
      choice,
      choice.preserveModelOrder || !choice.modelId ? null : modelRelease(choice),
    ]),
  );
  const newest = new Map<string, { choice: C; release: ModelRelease }>();
  for (const [choice, release] of releases) {
    if (!release) continue;
    const current = newest.get(release.family);
    if (!current || compareReleases(release, current.release) > 0) {
      newest.set(release.family, { choice, release });
    }
  }
  const latest: C[] = [];
  const older: C[] = [];
  for (const [choice, release] of releases) {
    const shown =
      !release || newest.get(release.family)?.choice === choice || choice.key === selectedKey;
    (shown ? latest : older).push(choice);
  }
  return { latest, older };
}

/**
 * A picker's provider sections with each model's older versions held back, unless the section's
 * key is in `expanded`; `collapsed` says the section has more to show.
 */
export function collapseOlderModels<
  S extends { key: string; heading?: string; data: ChatModelChoice[] },
>(
  sections: readonly S[],
  selectedKey: string,
  expanded: ReadonlySet<string>,
): (S & { collapsed: boolean })[] {
  return sections.map((section) => {
    const { latest, older } = section.heading
      ? latestModelChoices(section.data, selectedKey)
      : { latest: section.data, older: [] };
    const collapsed = older.length > 0 && !expanded.has(section.key);
    return { ...section, data: collapsed ? latest : section.data, collapsed };
  });
}

type ModelRelease = { family: string; version: number[]; tagged: boolean; date: number[] };

/**
 * Reads a model id as its vendor path, words, sizes (`120b`, `0.5b`, `4o`), a version, a date and
 * a local tag:
 * `claude-sonnet-4-5-20250929` is family `claude-sonnet`, version 4.5, dated 20250929.
 */
function modelRelease(choice: ChatModelChoice): ModelRelease {
  const id = (choice.modelId ?? "").toLowerCase();
  // A vendor path (`anthropic/`) and a local tag (`:8b-instruct-q4_0`) name different models
  // rather than releases, so they stay whole in the family.
  const vendor = id.slice(0, id.lastIndexOf("/") + 1);
  const [name = "", tag] = id.slice(vendor.length).split(/:(.*)/s);
  const words: string[] = [];
  const version: number[] = [];
  const date: number[] = [];
  let tagged = false;
  const parts = name.match(/\d+(?:\.\d+)?[a-z][a-z\d]*|[a-z]+|\d+/g) ?? [];
  let wordAfterVersion = false;
  for (const [index, part] of parts.entries()) {
    if (!/^\d+$/.test(part)) {
      if (RELEASE_TAGS.has(part)) tagged = true;
      else words.push(part);
      if (version.length) wordAfterVersion = true;
    } else if (
      // A date: `20250929`, `1106`, `001`, or numbers after a word that follows the version. A
      // bare `0` is a version part, as in `2.0`.
      date.length ||
      part.length >= 4 ||
      /^0\d/.test(part) ||
      wordAfterVersion ||
      // A month before a closing year (`08-2024`), not a version before `2025-08-07`.
      (/^20\d\d$/.test(parts[index + 1] ?? "") && !/^\d+$/.test(parts[index + 2] ?? ""))
    ) {
      date.push(Number(part));
    } else version.push(Number(part));
  }
  return {
    family: `${choice.provider ?? ""}:${choice.providerLabel ?? ""}:${vendor}${words.join("-")}:${tag ?? ""}`,
    version,
    tagged,
    // A year leads, so `12-2023` sorts before `08-2024`.
    date: [...date.filter(isYear), ...date.filter((part) => !isYear(part))],
  };
}

function isYear(part: number): boolean {
  return part >= 1990 && part <= 2099;
}

/**
 * Higher versions first. Within one version a stable id beats a preview, and an undated id (which
 * follows the newest) beats snapshots.
 */
function compareReleases(left: ModelRelease, right: ModelRelease): number {
  return (
    compareNumbers(left.version, right.version) ||
    Number(right.tagged) - Number(left.tagged) ||
    Number(!left.date.length) - Number(!right.date.length) ||
    compareNumbers(left.date, right.date)
  );
}

function compareNumbers(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

const RELEASE_TAGS = new Set(["latest", "preview", "exp"]);
const MODEL_VERSION = /\d+(?:[.-]\d{1,2}(?![\da-z]))*/i;

/**
 * The version a model id starts with, such as `[6, 1]` for `gpt-6.1-sol` or `[4, 5]` for
 * `x-4-5`. A part followed by letters is a size or variant, as in `llama-3-8b`, not a version.
 */
function modelVersion(id: string): number[] {
  const match = MODEL_VERSION.exec(id);
  return match ? match[0].split(/[.-]/).map(Number) : [];
}

/** Models with a higher version in their id first; the catalog's order otherwise stays. */
export function newestModelsFirst<T extends { id: string }>(models: readonly T[]): T[] {
  const versions = new Map(models.map((model) => [model.id, modelVersion(model.id)]));
  return [...models].sort((left, right) => {
    const a = versions.get(left.id) ?? [];
    const b = versions.get(right.id) ?? [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const difference = (b[index] ?? -1) - (a[index] ?? -1);
      if (difference) return difference;
    }
    return 0;
  });
}

/**
 * A chat's model picker: the model in use when no connection offers it any more (named by
 * `missing`, else its id), then every connected model.
 */
export function chatModelChoices(
  connected: readonly ConnectedModelChoice[],
  selectedKey: string,
  missing?: { label?: string; images?: boolean },
): ChatModelChoice[] {
  const choices: ChatModelChoice[] = [];
  if (selectedKey && !connected.some((option) => option.key === selectedKey)) {
    const saved = parseModelOptionKey(selectedKey);
    choices.push({
      key: selectedKey,
      label: missing?.label ?? saved?.modelId ?? selectedKey,
      provider: saved?.provider,
      modelId: saved?.modelId,
      ...(missing?.images === undefined ? {} : { images: missing.images }),
    });
  }
  return choices.concat(connected);
}

/**
 * Match a choice by label, model id, provider id, or (for a model that names its provider) the
 * provider's display name; a blank query keeps every choice. A choice without a provider only
 * uses providerLabel as a section heading, so that heading is not searched.
 */
export function filterModelChoices<C extends ChatModelChoice>(
  choices: readonly C[],
  query: string,
): readonly C[] {
  return listSearch(choices, query, { text: modelChoiceSearchText }).visible;
}

type SavedCompatibleModels = { baseUrl?: string; enabledModelIds?: readonly string[] };

/** The server's endpoint form; half-typed text that is not a URL yet compares as trimmed text. */
function comparableBaseUrl(baseUrl: string): string {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl);
  } catch {
    return baseUrl.trim();
  }
}

/** The saved enabled ids, but only while the form still points at the saved endpoint. */
export function savedCompatibleModelIds(
  credential: SavedCompatibleModels | undefined,
  baseUrl: string,
): string[] {
  if (
    !credential?.enabledModelIds ||
    comparableBaseUrl(credential.baseUrl ?? "") !== comparableBaseUrl(baseUrl)
  ) {
    return [];
  }
  return [...credential.enabledModelIds];
}

/** One row per model the endpoint may run: saved ids, then local ticks, then probed ids. */
export function compatibleModelRows(
  savedIds: readonly string[],
  enabledIds: readonly string[],
  probedIds: readonly string[],
): string[] {
  return [...new Set([...savedIds, ...enabledIds, ...probedIds])];
}

export function toggleEnabledModelId(
  enabledIds: readonly string[],
  id: string,
  enabled: boolean,
): string[] {
  return enabled ? [...new Set([...enabledIds, id])] : enabledIds.filter((entry) => entry !== id);
}

/**
 * Whether "Use this model" may switch the default to `modelId`. The server
 * refuses ids outside a saved list; an unread list (undefined) is not checked.
 */
export function canUseCompatibleModelAsDefault(
  savedIds: readonly string[] | undefined,
  modelId: string,
): boolean {
  return savedIds === undefined || savedIds.includes(modelId);
}

export const modelCatalogSearchText = (entry: ModelCatalogEntry) => [
  entry.label,
  entry.id,
  entry.providerName ?? entry.provider,
];

export const modelChoiceSearchText = (choice: ChatModelChoice) => [
  choice.label,
  choice.modelId,
  choice.provider,
  choice.provider ? choice.providerLabel : undefined,
];
