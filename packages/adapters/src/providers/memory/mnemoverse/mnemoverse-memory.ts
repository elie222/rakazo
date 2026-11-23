import type { MemoryProviderDefinition } from "../../../memory/memory-provider-descriptor.js";
import { MEMORY_SECRET_MIN_LENGTH } from "../../../memory/memory-provider-descriptor.js";
import { MNEMOVERSE_BASE_URL } from "./mnemoverse-client.js";
import {
  createMnemoverseProvider,
  prepareMnemoverseConnection,
} from "./mnemoverse-memory-provider.js";

export const mnemoverseMemory: MemoryProviderDefinition = {
  settings: {
    displayName: "Mnemoverse",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
        placeholder: "mk_live_…",
        minLength: MEMORY_SECRET_MIN_LENGTH,
        maxLength: 4096,
      },
    ],
    connectionLabel: () => "Mnemoverse",
  },
  // A hosted service only: there is no address for the operator to approve.
  requiresPrivateEndpoint: () => false,
  prepare: prepareMnemoverseConnection,
  create: createMnemoverseProvider,
  // The key only ever goes to the hosted API, so nothing a form can change moves it.
  credentialTarget: () => MNEMOVERSE_BASE_URL,
};
