import type { ProviderSettingsField } from "@rakazo/contracts";
import {
  classifyLocalServiceSettings,
  revalidateLocalServiceSettings,
} from "../../../local-service-endpoint.js";
import type { MemoryProviderDefinition } from "../../../memory-provider-descriptor.js";
import {
  connectionModeFields,
  MEMORY_SECRET_MIN_LENGTH,
  selfHostedLabel,
  serviceTarget,
} from "../../../memory-provider-descriptor.js";
import {
  createSupermemoryProvider,
  decodeLegacySupermemoryCredentials,
  prepareSupermemoryConnection,
  supermemoryRequiresPrivateEndpoint,
} from "./supermemory-memory-provider.js";

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

export const supermemoryMemory: MemoryProviderDefinition = {
  settings: {
    displayName: "Supermemory",
    fields: [
      apiKey("Organization API key", "cloud"),
      apiKey("Instance API key", "local"),
      ...connectionModeFields,
    ],
    connectionLabel: (settings) =>
      settings.mode === "cloud" ? "Supermemory Cloud" : selfHostedLabel(settings),
  },
  requiresPrivateEndpoint: supermemoryRequiresPrivateEndpoint,
  classifySettings: classifyLocalServiceSettings,
  revalidate: revalidateLocalServiceSettings,
  prepare: prepareSupermemoryConnection,
  create: createSupermemoryProvider,
  decodeLegacyCredentials: decodeLegacySupermemoryCredentials,
  credentialTarget: (settings) => serviceTarget(settings),
};
