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
  createHonchoProvider,
  honchoRequiresPrivateEndpoint,
  prepareHonchoConnection,
  UNRESERVED_HONCHO_PEER_PATTERN,
} from "./honcho-memory-provider.js";

const RESOURCE_ID = {
  pattern: "^[A-Za-z0-9_-]{1,512}$",
  message: "Use up to 512 letters, digits, _ or -.",
};

function apiKey(mode: string, placeholder?: string): ProviderSettingsField {
  return {
    key: "apiKey",
    label: "API key",
    kind: "secret",
    required: true,
    ...(placeholder ? { placeholder } : {}),
    minLength: MEMORY_SECRET_MIN_LENGTH,
    maxLength: 4096,
    visibleWhen: { key: "mode", equals: mode },
  };
}

export const honchoMemory: MemoryProviderDefinition = {
  settings: {
    displayName: "Honcho",
    fields: [
      apiKey("cloud", "hch-…"),
      apiKey("local"),
      ...connectionModeFields,
      {
        key: "workspaceId",
        label: "Workspace",
        kind: "text",
        required: false,
        placeholder: "rakazo-<space>",
        maxLength: 512,
        checks: [RESOURCE_ID],
        advanced: true,
        // The key can reach other workspaces and peers, so those are part of what it reaches.
        scopesSecrets: true,
      },
      {
        key: "userPeerId",
        label: "User peer",
        kind: "text",
        required: false,
        description: "Recall from this peer; save to Rakazo’s own peers.",
        maxLength: 512,
        checks: [
          RESOURCE_ID,
          {
            // Rakazo writes to these peers, so they cannot be read as the user's own peer.
            pattern: UNRESERVED_HONCHO_PEER_PATTERN,
            message: "rakazo-shared and IDs starting with bot- are reserved for Rakazo.",
          },
        ],
        advanced: true,
        // A user peer only exists in a workspace another app already writes to.
        visibleWhen: { key: "workspaceId" },
        scopesSecrets: true,
      },
    ],
    keptSettings: ["reasoningLevel"],
    connectionLabel: (settings) => {
      const { mode, workspaceId } = settings;
      if (mode === "local")
        return [selfHostedLabel(settings), workspaceId].filter(Boolean).join(", ");
      return workspaceId ? `Honcho Cloud (${workspaceId})` : "Honcho Cloud";
    },
  },
  requiresPrivateEndpoint: honchoRequiresPrivateEndpoint,
  classifySettings: classifyLocalServiceSettings,
  revalidate: revalidateLocalServiceSettings,
  prepare: prepareHonchoConnection,
  create: createHonchoProvider,
  credentialTarget: honchoTarget,
};

function honchoTarget(settings: Record<string, string>): string {
  // The key can reach other workspaces and peers, so those are part of what it reaches.
  return JSON.stringify([
    serviceTarget(settings, "cloud"),
    settings.workspaceId?.trim() ?? "",
    settings.userPeerId?.trim() ?? "",
  ]);
}
