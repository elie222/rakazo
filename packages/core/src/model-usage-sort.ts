import type {
  ModelCredential,
  ModelQuota,
  ModelRoleChoice,
  ModelRoleView,
} from "@rakazo/contracts";

export const MODEL_USAGE_SORT_KEY = "rakazo.modelUsageSort";
export const MODEL_USAGE_SORT_INVERTED_KEY = "rakazo.modelUsageSortInverted";
export const LEGACY_MODEL_USAGE_SORT_DIRECTION_KEY = "rakazo.modelUsageSortDirection";

export const MODEL_USAGE_SORT_OPTIONS = [
  "main-model",
  "approval-model",
  "quota",
  "alphabetical",
] as const;

export type ModelUsageSort = (typeof MODEL_USAGE_SORT_OPTIONS)[number];
export type ModelUsageSortInverted = boolean;

export function normalizeModelUsageSortInverted(value: unknown): ModelUsageSortInverted {
  return value === true || value === "true" || value === "reversed" || value === "least-remaining";
}

export function normalizeModelUsageSort(value: unknown): ModelUsageSort {
  if (value === "most-remaining" || value === "least-remaining") return "quota";
  return MODEL_USAGE_SORT_OPTIONS.includes(value as ModelUsageSort)
    ? (value as ModelUsageSort)
    : "quota";
}

export type ModelUsageSortEntry = {
  id: string;
  label: string;
  quota?: ModelQuota | null;
  mainRank?: number | null;
  approvalRank?: number | null;
};

export function modelUsageRoleRank(
  role: ModelRoleView | null | undefined,
  credentialId: string,
  credentials: readonly ModelCredential[] = [],
): number | null {
  if (!role) return null;
  const choices = [role.primary, ...role.backups].filter((choice) => choice !== null);
  const rank = choices.findIndex(
    (choice) => resolveRoleChoiceCredentialId(choice, credentials) === credentialId,
  );
  return rank < 0 ? null : rank;
}

function resolveRoleChoiceCredentialId(
  choice: ModelRoleChoice,
  credentials: readonly ModelCredential[],
): string | undefined {
  if (choice.credentialId) return choice.credentialId;
  const candidates = credentials.filter((credential) => credential.provider === choice.provider);
  const preferences = candidates
    .filter((credential) => credential.preferenceRank !== undefined)
    .sort((left, right) => left.preferenceRank! - right.preferenceRank!);
  const selected =
    preferences.find((credential) => credential.modelId === choice.modelId) ??
    preferences[0] ??
    candidates[0];
  if (!selected || choice.provider !== "openai-compatible") return selected?.id;
  if (selected.modelId === choice.modelId || selected.enabledModelIds?.includes(choice.modelId))
    return selected.id;
  return (
    candidates.find(
      (credential) =>
        credential.id !== selected.id && credential.enabledModelIds?.includes(choice.modelId),
    )?.id ?? selected.id
  );
}

export function sortModelUsageEntries<T extends ModelUsageSortEntry>(
  entries: readonly T[],
  order: ModelUsageSort,
  inverted = false,
  locale?: string,
): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return entries
    .map((entry, index) => ({ entry, index, remaining: lowestRemaining(entry.quota) }))
    .sort((left, right) => {
      if (order === "main-model" || order === "approval-model") {
        const a = order === "main-model" ? left.entry.mainRank : left.entry.approvalRank;
        const b = order === "main-model" ? right.entry.mainRank : right.entry.approvalRank;
        if (a == null || b == null) {
          if (a == null && b != null) return 1;
          if (a != null && b == null) return -1;
        } else if (a !== b) {
          return inverted ? b - a : a - b;
        }
        return (
          (inverted ? -1 : 1) * collator.compare(left.entry.label, right.entry.label) ||
          left.entry.id.localeCompare(right.entry.id) ||
          left.index - right.index
        );
      }
      if (order === "alphabetical") {
        return (
          (inverted ? -1 : 1) * collator.compare(left.entry.label, right.entry.label) ||
          left.entry.id.localeCompare(right.entry.id) ||
          left.index - right.index
        );
      }
      if (left.remaining === null || right.remaining === null) {
        if (left.remaining === null && right.remaining !== null) return 1;
        if (left.remaining !== null && right.remaining === null) return -1;
        return (
          collator.compare(left.entry.label, right.entry.label) ||
          left.entry.id.localeCompare(right.entry.id) ||
          left.index - right.index
        );
      }
      return (
        (inverted ? left.remaining - right.remaining : right.remaining - left.remaining) ||
        collator.compare(left.entry.label, right.entry.label) ||
        left.entry.id.localeCompare(right.entry.id) ||
        left.index - right.index
      );
    })
    .map(({ entry }) => entry);
}

function lowestRemaining(quota: ModelQuota | null | undefined): number | null {
  if (
    !quota ||
    quota.status === "unsupported" ||
    quota.status === "unavailable" ||
    !quota.windows.length
  )
    return null;
  return Math.min(...quota.windows.map((window) => 100 - window.usedPercent));
}
