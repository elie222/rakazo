import type { VoiceProvider, VoiceUsage } from "@rakazo/adapter-kit";
import type { VoiceCatalogEntry } from "@rakazo/contracts";
import type { VoiceConnectionFields, VoiceProviderOptions } from "./voice-provider-descriptor.js";
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

export function voiceDeploymentModelSupported(
  provider: string,
  model: string,
  operation: "synthesize" | "transcribe" = "synthesize",
): boolean {
  const definition = knownVoiceProvider(provider);
  const fixed =
    operation === "synthesize" ? definition?.synthesisModel : definition?.transcriptionModel;
  return !!definition && (!fixed || fixed === model);
}

/** Endpoint fields must affect dispatch whenever consent uses them to identify a recipient. */
export function voiceDeploymentConnectionSupported(
  provider: string,
  connection: VoiceConnectionFields,
  options: VoiceProviderOptions = {},
): boolean {
  const definition = knownVoiceProvider(provider);
  if (!definition || (connection.sttApiKey !== undefined && !connection.sttBaseUrl)) return false;
  if (definition.customEndpoints) {
    if (!connection.baseUrl) return false;
  } else if (
    [connection.baseUrl, connection.sttBaseUrl, connection.sttApiKey].some(
      (value) => value !== undefined,
    )
  ) {
    return false;
  }
  definition.validateConnection?.(connection, options);
  return true;
}

/** Undefined requires explicit operator acceptance of manual cost reconciliation. */
export function voiceDeploymentUsageUnit(
  provider: string,
  model: string,
  operation: "synthesize" | "transcribe",
): VoiceUsage["unit"] | undefined {
  return knownVoiceProvider(provider)?.deploymentUsageUnit?.(operation, model);
}
