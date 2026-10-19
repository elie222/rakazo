import type { ModelBackupChoice, ModelCatalogEntry, ModelCredential } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./domain.js";

export type ConnectedBackupOption = ModelBackupChoice & {
  label: string;
  providerName: string;
};

export function backupChoiceKey(choice: ModelBackupChoice): string {
  return JSON.stringify([choice.provider, choice.modelId]);
}

export function connectedBackupOptions(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[],
): ConnectedBackupOption[] {
  const connected = new Set(credentials.map((credential) => credential.provider));
  const options: ConnectedBackupOption[] = [];
  for (const entry of catalog) {
    if (
      !connected.has(entry.provider) ||
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
  const compatibleCredential = credentials.find(
    (credential) =>
      credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID && credential.modelId?.trim(),
  );
  if (compatibleCredential?.modelId) {
    const entry = catalog.find(
      (candidate) =>
        candidate.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
        candidate.id === compatibleCredential.modelId,
    );
    options.push({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: compatibleCredential.modelId,
      label: entry?.label ?? compatibleCredential.modelId,
      providerName: entry?.providerName ?? OPENAI_COMPATIBLE_PROVIDER_ID,
    });
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
        choice.provider === right[index]?.provider && choice.modelId === right[index]?.modelId,
    )
  );
}
