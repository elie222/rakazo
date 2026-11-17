import type { ProviderSettingsField } from "@rakazo/contracts";
import type { MemoryProviderDefinition } from "../../../memory/memory-provider-descriptor.js";
import {
  connectionModeFields,
  MEMORY_SECRET_MIN_LENGTH,
  selfHostedLabel,
  serviceTarget,
} from "../../../memory/memory-provider-descriptor.js";
import {
  classifyLocalServiceSettings,
  revalidateLocalServiceSettings,
} from "../../../network/local-service-endpoint.js";
import {
  createHindsightProvider,
  hindsightRequiresPrivateEndpoint,
  parseRecallBanks,
  prepareHindsightConnection,
} from "./hindsight-memory-provider.js";

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

export const hindsightMemory: MemoryProviderDefinition = {
  settings: {
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
  },
  requiresPrivateEndpoint: hindsightRequiresPrivateEndpoint,
  classifySettings: classifyLocalServiceSettings,
  revalidate: revalidateLocalServiceSettings,
  prepare: prepareHindsightConnection,
  create: createHindsightProvider,
  credentialTarget: hindsightTarget,
};

function hindsightTarget(settings: Record<string, string>): string {
  // The key can read other banks, so the banks recalled are part of what it reaches.
  const recallBanks = parseRecallBanks(settings.recallBanks).sort();
  return JSON.stringify([serviceTarget(settings, "cloud"), recallBanks]);
}
