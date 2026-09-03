import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentType } from "react";
import { SupermemorySettingsForm } from "./SupermemorySettingsForm";

export interface MemoryProviderConnectionDraft {
  settings: Record<string, string>;
  credentials: Record<string, string>;
}

export interface MemoryProviderSettingsFormProps {
  busy: boolean;
  onConnect: (draft: MemoryProviderConnectionDraft) => Promise<boolean>;
}

export interface MemoryProviderSettingsRegistration {
  id: string;
  name: string;
  description: string;
  SettingsForm: ComponentType<MemoryProviderSettingsFormProps>;
  connectedLabel: (config: SpaceMemoryConfig) => string;
}

export const MEMORY_PROVIDER_SETTINGS: readonly MemoryProviderSettingsRegistration[] = [
  {
    id: "supermemory",
    name: "Supermemory",
    description: "Add semantic recall alongside native MEMORY.md memory.",
    SettingsForm: SupermemorySettingsForm,
    connectedLabel: (config) =>
      config.settings.mode === "cloud" ? "Supermemory Cloud" : `Local · ${config.settings.baseUrl}`,
  },
];

export function memoryProviderSettings(provider: string) {
  return MEMORY_PROVIDER_SETTINGS.find((entry) => entry.id === provider) ?? null;
}

export function defaultMemoryProviderSettings(): MemoryProviderSettingsRegistration {
  const registration = MEMORY_PROVIDER_SETTINGS[0];
  if (!registration) throw new Error("No memory provider settings are registered.");
  return registration;
}
