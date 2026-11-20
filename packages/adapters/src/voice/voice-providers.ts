import { cartesiaVoice } from "../providers/voice/cartesia/cartesia-voice.js";
import { elevenlabsVoice } from "../providers/voice/elevenlabs/elevenlabs-voice.js";
import { fishAudioVoice } from "../providers/voice/fish-audio/fish-audio-voice.js";
import { macOsVoice } from "../providers/voice/macos/macos-voice.js";
import { openaiVoice } from "../providers/voice/openai/openai-voice.js";
import { openAiCompatibleVoice } from "../providers/voice/openai-compatible/openai-compatible-voice.js";
import { openRouterVoice } from "../providers/voice/openrouter/openrouter-voice.js";
import { scriptedVoice } from "../providers/voice/scripted/scripted-voice.js";
import { xaiVoice } from "../providers/voice/xai/xai-voice.js";
import type { VoiceProviderDefinition } from "./voice-provider-descriptor.js";

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
  openrouter: openRouterVoice,
  "openai-compatible": openAiCompatibleVoice,
  scripted: scriptedVoice,
} satisfies Record<string, VoiceProviderDefinition>;

/** An id this build has a voice provider for. Outside adapters a provider id is an opaque string. */
export type VoiceProviderId = keyof typeof voiceProviders;

export function knownVoiceProvider(id: string): VoiceProviderDefinition | undefined {
  return Object.hasOwn(voiceProviders, id) ? voiceProviders[id as VoiceProviderId] : undefined;
}
