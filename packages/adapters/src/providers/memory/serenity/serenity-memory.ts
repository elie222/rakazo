import type { MemoryProviderDefinition } from "../../../memory-provider-descriptor.js";
import { MEMORY_SECRET_MIN_LENGTH } from "../../../memory-provider-descriptor.js";
import { normalizeSerenityEndpoint } from "./serenity-client.js";
import {
  classifySerenityConnectionSettings,
  createSerenityProvider,
  prepareSerenityConnection,
  serenityRequiresPrivateEndpoint,
} from "./serenity-memory-provider.js";

export const serenityMemory: MemoryProviderDefinition = {
  settings: {
    displayName: "Serenity",
    fields: [
      {
        key: "endpoint",
        label: "MCP endpoint",
        kind: "text",
        // A blank endpoint is never filled with a hosted URL.
        required: true,
        requiredMessage: "Serenity endpoint is required.",
        placeholder: "https://serenity.sire.run/mcp",
        scopesSecrets: true,
      },
      {
        key: "token",
        label: "Bearer token",
        kind: "secret",
        required: true,
        placeholder: "sk_live_…",
        minLength: MEMORY_SECRET_MIN_LENGTH,
      },
      {
        key: "brainLabel",
        label: "Brain label",
        kind: "text",
        required: false,
        placeholder: "personal",
        advanced: true,
      },
      {
        key: "allowWrites",
        label: "Allow writing",
        kind: "select",
        required: true,
        default: "false",
        options: [
          { value: "false", label: "Recall only" },
          { value: "true", label: "Recall and write" },
        ],
        advanced: true,
      },
    ],
    connectionLabel: (settings) => {
      const label = settings.brainLabel?.trim();
      const endpoint = settings.endpoint ?? "Serenity";
      const mode = settings.allowWrites === "true" ? "read/write" : "recall only";
      return `${label || endpoint}, ${mode}`;
    },
  },
  requiresPrivateEndpoint: serenityRequiresPrivateEndpoint,
  classifySettings: classifySerenityConnectionSettings,
  prepare: (settings, credentials, options) =>
    prepareSerenityConnection(settings, credentials, undefined, options),
  create: createSerenityProvider,
  credentialTarget: serenityTarget,
};

function serenityTarget(settings: Record<string, string>): string {
  const endpoint = settings.endpoint?.trim() ?? "";
  try {
    return normalizeSerenityEndpoint(endpoint);
  } catch {
    return endpoint;
  }
}
