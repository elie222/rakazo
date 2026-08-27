import type { VoiceProvider } from "@rakazo/adapter-kit";
import { CartesiaVoiceProvider } from "./cartesia-voice.js";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";
import { OpenAIVoiceProvider } from "./openai-voice.js";
import { SCRIPTED_VOICE_CATALOG_ENTRY, ScriptedVoiceProvider } from "./scripted-voice.js";

export const VOICE_CATALOG = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    description: "Highest quality and cloning. Flash v2.5 for conversational calls.",
    transcribe: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "Simple TTS plus Whisper-class transcription. Reuse an OpenAI key.",
    transcribe: true,
  },
  {
    id: "cartesia",
    name: "Cartesia",
    description: "Lowest-latency Sonic voices for interruptible calls.",
    transcribe: false,
  },
] as const;

export { SCRIPTED_VOICE_CATALOG_ENTRY };

export type HostedVoiceProviderId = (typeof VOICE_CATALOG)[number]["id"];
export type VoiceProviderId = HostedVoiceProviderId | "scripted";

export function scriptedVoiceEnabled() {
  return process.env.AGENT_RUNTIME === "scripted";
}

export function listVoiceCatalog() {
  return scriptedVoiceEnabled()
    ? [...VOICE_CATALOG, SCRIPTED_VOICE_CATALOG_ENTRY]
    : [...VOICE_CATALOG];
}

export function voiceCatalogEntry(id: string) {
  if (id === SCRIPTED_VOICE_CATALOG_ENTRY.id) return SCRIPTED_VOICE_CATALOG_ENTRY;
  return VOICE_CATALOG.find((entry) => entry.id === id);
}

export function isVoiceProviderId(value: string): value is VoiceProviderId {
  if (value === "scripted") return scriptedVoiceEnabled();
  return VOICE_CATALOG.some((entry) => entry.id === value);
}

export function createVoiceProvider(kind: string): VoiceProvider {
  switch (kind) {
    case "elevenlabs":
      return new ElevenLabsVoiceProvider();
    case "openai":
      return new OpenAIVoiceProvider();
    case "cartesia":
      return new CartesiaVoiceProvider();
    case "scripted":
      if (!scriptedVoiceEnabled()) break;
      return new ScriptedVoiceProvider();
    default:
      break;
  }
  throw new Error(`Unknown voice provider "${kind}". Use elevenlabs | openai | cartesia.`);
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

export const MAX_SPEAK_CHARS = 2000;
export const MAX_TRANSCRIBE_BYTES = 8 * 1024 * 1024;
