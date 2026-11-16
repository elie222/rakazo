import type { VoiceProvider } from "@rakazo/adapter-kit";
import type { VoiceCatalogEntry } from "@rakazo/contracts";
import type { VoiceProviderOptions } from "./voice-provider-descriptor.js";
import type { VoiceProviderId } from "./voice-providers.js";
import { knownVoiceProvider, voiceProviders } from "./voice-providers.js";

export function listVoiceCatalog(options: VoiceProviderOptions = {}): VoiceCatalogEntry[] {
  return Object.entries(voiceProviders).flatMap(([id, provider]) =>
    (provider.available?.() ?? true) && (provider.listed?.(options) ?? true)
      ? [{ id, ...provider.catalog }]
      : [],
  );
}

export function voiceCatalogEntry(id: string): VoiceCatalogEntry | undefined {
  const provider = knownVoiceProvider(id);
  return provider && { id, ...provider.catalog };
}

export function isVoiceProviderId(value: string): value is VoiceProviderId {
  const provider = knownVoiceProvider(value);
  return !!provider && (provider.available?.() ?? true);
}

export function createVoiceProvider(
  kind: string,
  options: VoiceProviderOptions = {},
): VoiceProvider {
  if (isVoiceProviderId(kind)) return voiceProviders[kind].create(options);
  throw new Error(
    `Unknown voice provider "${kind}". Use ${Object.keys(voiceProviders).filter(isVoiceProviderId).join(" | ")}.`,
  );
}

export class NoVoiceConfigured extends Error {
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice") {
    super(
      reason === "key"
        ? "Add a voice provider key in Voice settings to turn on speaking."
        : "Pick a voice in Voice settings.",
    );
    this.reason = reason;
    this.name = "NoVoiceConfigured";
  }
}

export { isSpeechModelId, MAX_SPEAK_CHARS } from "./voice-http.js";
export const MAX_TRANSCRIBE_BYTES = 8 * 1024 * 1024;
