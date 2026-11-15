import type { MemoryProviderDescriptor, ProviderSettingsField } from "@rakazo/contracts";

export interface SettingsMemoryProvider extends MemoryProviderDescriptor {
  /** One line naming a saved connection, shown beside its connected state. */
  connectionLabel(settings: Record<string, string>): string;
  /** Saved settings no field edits; an edit keeps their stored values. */
  keptSettings?: readonly string[];
}

/** Every provider turns a key shorter than this down. */
export const MEMORY_SECRET_MIN_LENGTH = 8;

/** The hosted service, or a self-hosted server at a base URL. Both decide what a key reaches. */
export const connectionModeFields: readonly ProviderSettingsField[] = [
  {
    key: "mode",
    label: "Connection",
    kind: "select",
    required: true,
    default: "cloud",
    options: [
      { value: "cloud", label: "Cloud" },
      { value: "local", label: "Self-hosted" },
    ],
    advanced: true,
    scopesSecrets: true,
  },
  {
    key: "baseUrl",
    label: "Base URL",
    kind: "url",
    required: true,
    placeholder: "https://…",
    advanced: true,
    visibleWhen: { key: "mode", equals: "local" },
    scopesSecrets: true,
  },
];

/** "Self-hosted (https://memory.example.test)", for a connection to someone's own server. */
export function selfHostedLabel(settings: Record<string, string>): string {
  return `Self-hosted (${settings.baseUrl})`;
}
