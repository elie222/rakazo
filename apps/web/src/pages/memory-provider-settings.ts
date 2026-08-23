import { SupermemorySettingsOverlay } from "./SupermemorySettingsOverlay";

export const MEMORY_PROVIDER_SETTINGS = [
  { id: "supermemory", Settings: SupermemorySettingsOverlay },
] as const;

export function memoryProviderSettings(provider?: string) {
  if (!provider) return MEMORY_PROVIDER_SETTINGS[0];
  return MEMORY_PROVIDER_SETTINGS.find((entry) => entry.id === provider) ?? null;
}
