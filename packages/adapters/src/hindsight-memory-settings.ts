import type { ProviderSettingsField } from "@rakazo/contracts";
import { HINDSIGHT_PROVIDER_ID } from "./hindsight-memory-provider.js";
import type { SettingsMemoryProvider } from "./memory-provider-descriptor.js";
import {
  connectionModeFields,
  MEMORY_SECRET_MIN_LENGTH,
  selfHostedLabel,
} from "./memory-provider-descriptor.js";

function apiKey(mode: string, required: boolean): ProviderSettingsField {
  return {
    key: "apiKey",
    label: "API key",
    kind: "secret",
    required,
    minLength: MEMORY_SECRET_MIN_LENGTH,
    maxLength: 4096,
    visibleWhen: { key: "mode", equals: mode },
  };
}

function toggle(key: string, label: string, on: boolean): ProviderSettingsField {
  return { key, label, kind: "toggle", required: true, default: String(on), advanced: true };
}

export const hindsightMemorySettings: SettingsMemoryProvider = {
  id: HINDSIGHT_PROVIDER_ID,
  displayName: "Hindsight",
  fields: [
    apiKey("cloud", true),
    // A self-hosted server runs without authentication by default.
    apiKey("local", false),
    ...connectionModeFields,
    {
      key: "recallBanks",
      label: "Recall from banks",
      kind: "list",
      required: false,
      maxLength: 2048,
      advanced: true,
      // The key can read other banks, so the banks recalled are part of what it reaches.
      scopesSecrets: true,
    },
    toggle("retainConversations", "Learn from conversations", true),
    toggle("autoRecall", "Recall automatically", true),
    {
      key: "recallBudget",
      label: "Recall depth",
      kind: "select",
      required: true,
      default: "mid",
      options: [
        { value: "low", label: "Low" },
        { value: "mid", label: "Medium" },
        { value: "high", label: "High" },
      ],
      advanced: true,
    },
    {
      key: "recallFacts",
      label: "What to recall",
      kind: "select",
      required: true,
      default: "false",
      options: [
        { value: "false", label: "Summaries" },
        { value: "true", label: "Summaries and facts" },
      ],
      advanced: true,
    },
    toggle("skipUnrelated", "Skip unrelated memories", false),
  ],
  connectionLabel: (settings) =>
    settings.mode === "local" ? selfHostedLabel(settings) : "Hindsight Cloud",
};
