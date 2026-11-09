import type { SpaceMemoryConfig } from "@rakazo/contracts";
import type { ComponentType } from "react";
import { HonchoSettingsForm } from "./HonchoSettingsForm";

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
  SettingsForm: ComponentType<MemoryProviderSettingsFormProps>;
  connectedLabel: (config: SpaceMemoryConfig) => string;
}

export const MEMORY_PROVIDER_SETTINGS: readonly MemoryProviderSettingsRegistration[] = [
  {
    id: "honcho",
    name: "Honcho",
    SettingsForm: HonchoSettingsForm,
    connectedLabel: (config) => {
      const { mode, baseUrl, workspaceId } = config.settings;
      if (mode === "local")
        return [`Self-hosted (${baseUrl})`, workspaceId].filter(Boolean).join(", ");
      return workspaceId ? `Honcho Cloud (${workspaceId})` : "Honcho Cloud";
    },
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
