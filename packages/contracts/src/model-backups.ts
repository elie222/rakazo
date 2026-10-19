import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./domain.js";
import { canonicalPiProviderId } from "./model-provider.js";

export type ConnectedBackupOption = ModelBackupChoice & {
  label: string;
  providerName: string;
};

export function backupChoiceKey(choice: ModelBackupChoice): string {
  return JSON.stringify([canonicalPiProviderId(choice.provider), choice.modelId]);
}

export function connectedBackupOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
): ConnectedBackupOption[] {
  const connected = new Set(
    credentials.map((credential) => canonicalPiProviderId(credential.provider)),
  );
  const options: ConnectedBackupOption[] = [];
  for (const entry of catalog) {
    if (
      !connected.has(canonicalPiProviderId(entry.provider)) ||
      entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID ||
      entry.placeholder
    ) {
      continue;
    }
    options.push({
      provider: entry.provider,
      modelId: entry.id,
      label: entry.label,
      providerName: entry.providerName ?? entry.provider,
    });
  }
  const seen = new Set<string>();
  for (const credential of credentials) {
    if (credential.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) continue;
    for (const raw of credential.enabledModelIds ?? [credential.modelId ?? ""]) {
      const modelId = raw.trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      const entry = catalog.find(
        (candidate) =>
          candidate.provider === OPENAI_COMPATIBLE_PROVIDER_ID && candidate.id === modelId,
      );
      options.push({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId,
        label: entry?.label ?? modelId,
        providerName: entry?.providerName ?? OPENAI_COMPATIBLE_PROVIDER_ID,
      });
    }
  }
  return options;
}

export function moveBackupChoice(
  choices: ModelBackupChoice[],
  index: number,
  direction: -1 | 1,
): ModelBackupChoice[] {
  const target = index + direction;
  if (index < 0 || index >= choices.length || target < 0 || target >= choices.length) {
    return choices;
  }
  const next = [...choices];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function sameBackupChoices(left: ModelBackupChoice[], right: ModelBackupChoice[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (choice, index) =>
        canonicalPiProviderId(choice.provider) ===
          canonicalPiProviderId(right[index]?.provider ?? "") &&
        choice.modelId === right[index]?.modelId,
    )
  );
}
