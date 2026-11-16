import type { ProviderSettingsField } from "@rakazo/contracts";
import type { SettingsMemoryProvider } from "./memory-provider-descriptor.js";
import {
  connectionModeFields,
  MEMORY_SECRET_MIN_LENGTH,
  selfHostedLabel,
} from "./memory-provider-descriptor.js";
import { SUPERMEMORY_PROVIDER_ID } from "./supermemory-memory-provider.js";

function apiKey(label: string, mode: string): ProviderSettingsField {
  return {
    key: "apiKey",
    label,
    kind: "secret",
    required: true,
    placeholder: "sm_…",
    minLength: MEMORY_SECRET_MIN_LENGTH,
    visibleWhen: { key: "mode", equals: mode },
  };
}

export const supermemoryMemorySettings: SettingsMemoryProvider = {
  id: SUPERMEMORY_PROVIDER_ID,
  displayName: "Supermemory",
  fields: [
    apiKey("Organization API key", "cloud"),
    apiKey("Instance API key", "local"),
    ...connectionModeFields,
  ],
  connectionLabel: (settings) =>
    settings.mode === "cloud" ? "Supermemory Cloud" : selfHostedLabel(settings),
};
