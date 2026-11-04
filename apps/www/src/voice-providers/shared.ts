import type { SourceLink } from "../alternatives";
import type { ArticleImage, ArticleTable } from "../provider-article/types";
import { GITHUB_URL } from "../site";

export const VOICE_PROVIDERS_PATH = "/voice-providers/";
export const VOICE_PROVIDERS_UPDATED = "November 4, 2026";
export const VOICE_DOCS_PATH = "/docs/voice-and-calls/";

export function voiceProviderPath(slug: string): string {
  return `${VOICE_PROVIDERS_PATH}${slug}/`;
}

/** A screenshot in `public/graphics/voice-providers/`. */
export function homepage(slug: string, provider: string, alt: string): ArticleImage {
  return {
    webp: `/graphics/voice-providers/${slug}.webp`,
    avif: `/graphics/voice-providers/${slug}.avif`,
    width: 1280,
    height: 800,
    alt,
    caption: `The ${provider} homepage.`,
  };
}

export const VOICE_DOC: SourceLink = {
  label: "Rakazo, voice and calls",
  href: `${GITHUB_URL}/blob/main/docs/voice-and-calls.md`,
};

export const VOICE_MODELS_DOC: SourceLink = {
  label: "Rakazo, self-hosted voice settings",
  href: `${GITHUB_URL}/blob/main/docs/self-host-models.md#voice`,
};

/** Pricing pages behind the tables, checked on {@link VOICE_PROVIDERS_UPDATED}. */
export const PRICING_SOURCES = {
  elevenlabs: { label: "ElevenLabs, pricing", href: "https://elevenlabs.io/pricing" },
  elevenlabsApi: { label: "ElevenLabs, API pricing", href: "https://elevenlabs.io/pricing/api" },
  openai: { label: "OpenAI, API pricing", href: "https://developers.openai.com/api/docs/pricing" },
  cartesia: { label: "Cartesia, pricing", href: "https://cartesia.ai/pricing" },
  fish: {
    label: "Fish Audio, API pricing and rate limits",
    href: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits",
  },
  fishPlans: { label: "Fish Audio, plans", href: "https://fish.audio/plan" },
  deepgram: { label: "Deepgram, pricing", href: "https://deepgram.com/pricing" },
  google: {
    label: "Google Cloud, Text-to-Speech pricing",
    href: "https://cloud.google.com/text-to-speech/pricing",
  },
  googleStt: {
    label: "Google Cloud, Speech-to-Text pricing",
    href: "https://cloud.google.com/speech-to-text/pricing",
  },
  azure: {
    label: "Azure AI Speech, pricing",
    href: "https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/",
  },
  polly: { label: "Amazon Polly, pricing", href: "https://aws.amazon.com/polly/pricing/" },
  transcribe: {
    label: "Amazon Transcribe, pricing",
    href: "https://aws.amazon.com/transcribe/pricing/",
  },
  inworld: { label: "Inworld, pricing", href: "https://inworld.ai/pricing" },
  deepinfra: { label: "DeepInfra, Kokoro-82M", href: "https://deepinfra.com/hexgrad/Kokoro-82M" },
  together: { label: "Together AI, pricing", href: "https://www.together.ai/pricing" },
  groq: {
    label: "Groq, speech to text",
    href: "https://console.groq.com/docs/speech-to-text",
  },
  assemblyai: { label: "AssemblyAI, pricing", href: "https://www.assemblyai.com/pricing" },
} satisfies Record<string, SourceLink>;

export const PRICE_NOTE =
  "Prices in US dollars from each provider's pricing page, checked November 2026. An hour of speech is taken as about 54,000 characters (150 words a minute); real voices run a little faster or slower.";

const PRICE_COLUMNS = [
  "Option",
  "Speech per 1M characters",
  "About per hour of speech",
  "Transcription per hour",
  "Free to start",
  "In Rakazo",
] as const;

/** One source of truth for the per-unit prices every voice article compares. */
const PRICE_ROWS = {
  elevenlabs: {
    topic: "[ElevenLabs](/voice-providers/elevenlabs/) Flash v2.5",
    cells: [
      "$40",
      "$2.16",
      "$0.22 (Scribe v2)",
      "10,000 credits a month, non-commercial",
      "Built in, speaks and transcribes",
    ],
  },
  elevenlabsV4: {
    topic: "ElevenLabs v4 or Multilingual v2",
    cells: ["$80", "$4.32", "Same as above", "Same plans", "Not selectable"],
  },
  openai: {
    topic: "[OpenAI](/voice-providers/openai/) `gpt-4o-mini-tts`",
    cells: [
      "About $17, billed in tokens",
      "About $0.90",
      "$0.18 (`gpt-4o-mini-transcribe`)",
      "None",
      "Built in until January 6, 2027",
    ],
  },
  openaiTts1: {
    topic: "OpenAI `tts-1` or `tts-1-hd`",
    cells: ["$15 or $30", "$0.81 or $1.62", "$0.36 (Whisper)", "None", "Not used"],
  },
  cartesia: {
    topic: "[Cartesia](/voice-providers/cartesia/) Sonic 3",
    cells: [
      "$37 to $50, by plan",
      "$2.02 to $2.70",
      "$0.39 to $0.54 (Ink, not used by Rakazo)",
      "20,000 credits a month",
      "Built in, speaks only",
    ],
  },
  fish: {
    topic: "[Fish Audio](/voice-providers/fish-audio/) S2.1 Pro",
    cells: [
      "$15 per 1M bytes",
      "$0.81",
      "$0.36",
      "`s2.1-pro-free` costs nothing until November 30, 2026",
      "Built in, speaks and transcribes",
    ],
  },
  selfHosted: {
    topic: "[Kokoro and Whisper](/voice-providers/self-hosted/) on your hardware",
    cells: [
      "Hardware only",
      "Hardware only",
      "Hardware only",
      "Open source",
      "Built in as **Self-hosted**",
    ],
  },
  hostedKokoro: {
    topic: "Kokoro on DeepInfra or Together AI",
    cells: [
      "$0.99 or $4",
      "$0.05 or $0.22",
      "Whisper from $0.012 (DeepInfra)",
      "Pay as you go",
      "Possibly through **Self-hosted**, untested",
    ],
  },
  macos: {
    topic: "[Server (Mac)](/voice-providers/macos/)",
    cells: [
      "Free",
      "Free",
      "None; your device listens",
      "Built into macOS",
      "Built in when the server runs on a Mac",
    ],
  },
  deepgram: {
    topic: "Deepgram Aura-2 and Nova-3",
    cells: [
      "$30",
      "$1.62",
      "$0.26 batch, $0.46 streaming",
      "$200 credit",
      "Not available",
    ],
  },
  google: {
    topic: "Google Cloud Chirp 3 HD",
    cells: ["$30", "$1.62", "$0.96", "1M characters a month", "Not available"],
  },
  azure: {
    topic: "Azure AI Speech, neural or HD",
    cells: [
      "$15 or $22",
      "$0.81 or $1.19",
      "$1.00 real time, $0.18 batch",
      "0.5M characters and 5 hours a month",
      "Not available",
    ],
  },
  polly: {
    topic: "Amazon Polly neural or generative",
    cells: [
      "$16 or $30",
      "$0.86 or $1.62",
      "$0.36 batch, $0.60 streaming (Transcribe)",
      "Neural: 1M characters a month for a year",
      "Not available",
    ],
  },
  inworld: {
    topic: "Inworld TTS-2 or TTS-2 Flash",
    cells: ["$25 or $15", "$1.35 or $0.81", "$0.15", "Up to 70 minutes of speech", "Not available"],
  },
} satisfies Record<string, { topic: string; cells: readonly string[] }>;

export type VoicePriceRow = keyof typeof PRICE_ROWS;

/** A price comparison across the chosen rows, in the shared units. */
export function voicePriceTable(caption: string, rows: readonly VoicePriceRow[]): ArticleTable {
  return {
    caption,
    columns: PRICE_COLUMNS,
    rows: rows.map((row) => PRICE_ROWS[row]),
    note: PRICE_NOTE,
  };
}

/** Sources for every row in {@link PRICE_ROWS}, for pages that show the full table. */
export const ALL_PRICING_SOURCES: readonly SourceLink[] = Object.values(PRICING_SOURCES);

export const WORKLOAD =
  "The worked example is one bot that reads about 30 minutes of replies aloud each day and transcribes about 30 minutes of what you say, every day for a month: 15 hours of speech (about 810,000 characters) and 15 hours of transcription.";

const WORKLOAD_ROWS = {
  elevenlabs: {
    topic: "[ElevenLabs](/voice-providers/elevenlabs/)",
    cells: ["$32.40", "$3.30", "About $36"],
  },
  openai: {
    topic: "[OpenAI](/voice-providers/openai/)",
    cells: ["About $13.50", "$2.70", "About $16, until the 2027 shutdown"],
  },
  cartesia: {
    topic: "[Cartesia](/voice-providers/cartesia/)",
    cells: ["$49 (Startup plan)", "$0, your device listens", "$49"],
  },
  fish: {
    topic: "[Fish Audio](/voice-providers/fish-audio/)",
    cells: ["$12.15", "$5.40", "About $18"],
  },
  selfHosted: {
    topic: "[Self-hosted](/voice-providers/self-hosted/) on a computer you own",
    cells: ["Electricity", "Electricity", "About $0"],
  },
  selfHostedCloud: {
    topic: "Self-hosted on a small rented CPU server",
    cells: ["Included", "Included", "About $10, slower"],
  },
  macos: {
    topic: "[Server (Mac)](/voice-providers/macos/)",
    cells: ["$0", "$0, your device listens", "$0"],
  },
  deepgram: { topic: "Deepgram (not in Rakazo)", cells: ["$24.30", "$3.87", "About $28"] },
  google: {
    topic: "Google Cloud (not in Rakazo)",
    cells: ["$0, inside the free 1M", "$14.40", "About $14"],
  },
  azure: {
    topic: "Azure AI Speech (not in Rakazo)",
    cells: ["$4.65 after the free 0.5M", "$10 after 5 free hours", "About $15"],
  },
} satisfies Record<string, { topic: string; cells: readonly string[] }>;

export type VoiceWorkloadRow = keyof typeof WORKLOAD_ROWS;

/** What the {@link WORKLOAD} costs a month on the chosen options. */
export function voiceWorkloadTable(
  caption: string,
  rows: readonly VoiceWorkloadRow[],
): ArticleTable {
  return {
    caption,
    columns: ["Option", "Speech", "Transcription", "A month"],
    rows: rows.map((row) => WORKLOAD_ROWS[row]),
    note: "Usage prices only, from each provider's pricing page, checked November 2026. Rakazo doesn't charge for voice: you connect your own key and the provider bills you.",
  };
}
