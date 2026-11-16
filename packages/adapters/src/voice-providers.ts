import { cartesiaVoice } from "./cartesia-voice.js";
import { elevenlabsVoice } from "./elevenlabs-voice.js";
import { fishAudioVoice } from "./fish-audio-voice.js";
import { macOsVoice } from "./macos-voice.js";
import { openAiCompatibleVoice } from "./openai-compatible-voice.js";
import { openaiVoice } from "./openai-voice.js";
import { scriptedVoice } from "./scripted-voice.js";
import type { VoiceProviderDefinition } from "./voice-provider-descriptor.js";
import { xaiVoice } from "./xai-voice.js";

/**
 * Every voice provider this build has, by id. The factory, the catalog and the conformance
 * fixtures all read from here. Settings lists them in this order.
 */
export const voiceProviders = {
  macos: macOsVoice,
  elevenlabs: elevenlabsVoice,
  openai: openaiVoice,
  cartesia: cartesiaVoice,
  "fish-audio": fishAudioVoice,
  xai: xaiVoice,
  "openai-compatible": openAiCompatibleVoice,
  scripted: scriptedVoice,
} satisfies Record<string, VoiceProviderDefinition>;

/** An id this build has a voice provider for. Outside adapters a provider id is an opaque string. */
export type VoiceProviderId = keyof typeof voiceProviders;

export function knownVoiceProvider(id: string): VoiceProviderDefinition | undefined {
  return Object.hasOwn(voiceProviders, id) ? voiceProviders[id as VoiceProviderId] : undefined;
}
