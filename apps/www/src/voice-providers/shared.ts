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
  hetzner: { label: "Hetzner, cloud servers", href: "https://www.hetzner.com/cloud/" },
} satisfies Record<string, SourceLink>;


/** The speaking pace every per-hour figure assumes: 150 words, about 900 characters, a minute. */
export const CHARS_PER_MINUTE = 900;
export const CHARS_PER_HOUR = CHARS_PER_MINUTE * 60;

/** "$40" for whole dollars, otherwise cents ("$2.16"). */
export function usd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (Number.isInteger(rounded)) return `$${rounded}`;
  return `$${rounded.toFixed(2)}`;
}

/** Millions of characters, such as "1M" or "0.5M". */
export function millions(value: number): string {
  return `${value / 1_000_000}M`;
}

/** A credit allowance: "100,000", or "1.8M" from a million up. */
export function credits(value: number): string {
  return value >= 1_000_000 ? millions(value) : count(value);
}

/** Thousands separators, such as "810,000". */
export function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Cost in dollars of an hour of speech at {@link CHARS_PER_HOUR}, from a price per 1M characters. */
export function speechHourCost(pricePerMillion: number): number {
  return (pricePerMillion * CHARS_PER_HOUR) / 1_000_000;
}

/** {@link speechHourCost}, formatted. */
export function perHourOfSpeech(pricePerMillion: number): string {
  return usd(speechHourCost(pricePerMillion));
}

/** OpenAI's per-minute transcription prices, as of November 2026. */
const OPENAI_TRANSCRIBE_MINUTE = {
  mini: 0.003,
  gpt: 0.0045,
  gpt4o: 0.006,
  live: 0.017,
} as const;

/**
 * Prices in US dollars, as of November 2026, behind every voice table, worked example and
 * sentence that quotes one. Speech is per 1M characters unless the name says otherwise.
 */
export const RATES = {
  elevenlabsFlash: 40,
  elevenlabsV4: 80,
  elevenlabsScribeHour: 0.22,
  elevenlabsScribeRealtimeHour: 0.39,
  elevenlabsAgentsMinute: 0.08,
  elevenlabsPlans: {
    free: { price: 0, credits: 10_000 },
    starter: { price: 6, credits: 30_000 },
    creator: { price: 22, credits: 121_000 },
    pro: { price: 99, credits: 600_000 },
    scale: { price: 299, credits: 1_800_000 },
    business: { price: 990, credits: 6_000_000 },
  },
  openaiMiniTtsMinute: 0.015,
  openaiMiniTtsTextIn: 0.6,
  openaiMiniTtsAudioOut: 12,
  openaiRealtimeMiniAudioIn: 10,
  openaiRealtimeMiniAudioOut: 20,
  openaiTts1: 15,
  openaiTts1Hd: 30,
  openaiTranscribeMinute: OPENAI_TRANSCRIBE_MINUTE,
  openaiMiniTranscribeHour: OPENAI_TRANSCRIBE_MINUTE.mini * 60,
  openaiWhisperHour: OPENAI_TRANSCRIBE_MINUTE.gpt4o * 60,
  /** Cartesia plans: price a month and credits included; Sonic uses one credit per character. */
  cartesiaFreeCredits: 20_000,
  cartesiaPlans: {
    pro: { price: 5, credits: 100_000, overage: 65 },
    startup: { price: 49, credits: 1_250_000, overage: 45 },
    scale: { price: 299, credits: 8_000_000, overage: 38 },
  },
  /** Ink transcription uses 3 credits per second of audio. */
  cartesiaInkCreditsPerHour: 3 * 3600,
  cartesiaAgentsMinute: 0.03,
  fish: 15,
  fishDrama3: 50,
  fishTranscribeHour: 0.36,
  /** Fish Audio app plans: price, yearly price per month, credits, and the minutes its plan page says they buy. */
  fishPlans: {
    free: { price: 0, yearly: 0, credits: 8_000, minutes: 7 },
    plus: { price: 15, yearly: 11, credits: 250_000, minutes: 200 },
    pro: { price: 100, yearly: 75, credits: 2_000_000, minutes: 1_620 },
  },
  deepgram: 30,
  deepgramBatchHour: 0.258,
  deepgramStreamHour: 0.462,
  deepgramCredit: 200,
  googleChirp: 30,
  googleFreeChars: 1_000_000,
  googleSttHour: 0.96,
  azureNeural: 15,
  azureHd: 22,
  azureFreeChars: 500_000,
  azureFreeHours: 5,
  azureRealtimeHour: 1,
  azureBatchHour: 0.18,
  pollyNeural: 16,
  pollyGenerative: 30,
  transcribeBatchHour: 0.36,
  transcribeStreamHour: 0.6,
  inworld: 25,
  inworldFlash: 15,
  inworldSttHour: 0.15,
  assemblyaiHour: { low: 0.15, high: 0.45 },
  groqWhisperHour: 0.04,
  deepinfraKokoro: 0.99,
  deepinfraWhisperHour: 0.012,
  togetherKokoro: 4,
  /** A small rented CPU server (Hetzner CX33, €8.99), in dollars a month. */
  cpuServerMonth: 10,
} as const;

/** Effective Cartesia price per 1M characters on a plan. */
export function cartesiaPerMillion(plan: keyof typeof RATES.cartesiaPlans): number {
  const { price, credits } = RATES.cartesiaPlans[plan];
  return (price / credits) * 1_000_000;
}

/** Cartesia Ink, per hour of audio, on a plan. */
export function cartesiaInkPerHour(plan: keyof typeof RATES.cartesiaPlans): string {
  return usd((RATES.cartesiaInkCreditsPerHour * cartesiaPerMillion(plan)) / 1_000_000);
}

const OPENAI_MINI_TTS_HOUR = RATES.openaiMiniTtsMinute * 60;
const OPENAI_MINI_TTS_PER_MILLION = (RATES.openaiMiniTtsMinute / CHARS_PER_MINUTE) * 1_000_000;
export const OPENAI_MINI_TTS = {
  perHour: usd(OPENAI_MINI_TTS_HOUR),
  perMillion: `$${Math.round(OPENAI_MINI_TTS_PER_MILLION)}`,
};

export const PRICE_NOTE = `Prices in US dollars from each provider's pricing page, checked November 2026. An hour of speech is taken as about ${count(CHARS_PER_HOUR)} characters (150 words a minute); real voices run a little faster or slower. Fish Audio bills per UTF-8 byte, which is one byte per character in English.`;

const PRICE_COLUMNS = [
  "Option",
  "Speech per 1M characters",
  "About per hour of speech",
  "Transcription per hour",
  "Free to start",
  "In Rakazo",
] as const;

/** Cartesia plans ordered by effective price per character, cheapest first. */
export const CARTESIA_PLANS_BY_RATE = (
  Object.keys(RATES.cartesiaPlans) as (keyof typeof RATES.cartesiaPlans)[]
).sort((a, b) => cartesiaPerMillion(a) - cartesiaPerMillion(b));
const cartesiaCheapest = CARTESIA_PLANS_BY_RATE[0] ?? "scale";
const cartesiaDearest = CARTESIA_PLANS_BY_RATE.at(-1) ?? "pro";
export const CARTESIA_RANGE = {
  low: cartesiaPerMillion(cartesiaCheapest),
  high: cartesiaPerMillion(cartesiaDearest),
};
const cartesiaLow = CARTESIA_RANGE.low;
const cartesiaHigh = CARTESIA_RANGE.high;

/** One source of truth for the per-unit prices every voice article compares. */
const PRICE_ROWS = {
  elevenlabs: {
    topic: "[ElevenLabs](/voice-providers/elevenlabs/) Flash v2.5",
    cells: [
      usd(RATES.elevenlabsFlash),
      perHourOfSpeech(RATES.elevenlabsFlash),
      `${usd(RATES.elevenlabsScribeHour)} (Scribe v2)`,
      `${count(RATES.elevenlabsPlans.free.credits)} credits a month, non-commercial`,
      "Built in, speaks and transcribes",
    ],
  },
  elevenlabsV4: {
    topic: "ElevenLabs v4 or Multilingual v2",
    cells: [
      usd(RATES.elevenlabsV4),
      perHourOfSpeech(RATES.elevenlabsV4),
      "Same as above",
      "Same plans",
      "Not selectable",
    ],
  },
  openai: {
    topic: "[OpenAI](/voice-providers/openai/) `gpt-4o-mini-tts`",
    cells: [
      `About ${OPENAI_MINI_TTS.perMillion}, billed in tokens`,
      `About ${OPENAI_MINI_TTS.perHour}`,
      `${usd(RATES.openaiMiniTranscribeHour)} (\`gpt-4o-mini-transcribe\`)`,
      "None",
      "Built in until January 6, 2027",
    ],
  },
  openaiTts1: {
    topic: "OpenAI `tts-1` or `tts-1-hd`",
    cells: [
      `${usd(RATES.openaiTts1)} or ${usd(RATES.openaiTts1Hd)}`,
      `${perHourOfSpeech(RATES.openaiTts1)} or ${perHourOfSpeech(RATES.openaiTts1Hd)}`,
      `${usd(RATES.openaiWhisperHour)} (Whisper)`,
      "None",
      "Not used",
    ],
  },
  cartesia: {
    topic: "[Cartesia](/voice-providers/cartesia/) Sonic 3",
    cells: [
      `${usd(cartesiaLow)} to ${usd(cartesiaHigh)}, by plan`,
      `${perHourOfSpeech(cartesiaLow)} to ${perHourOfSpeech(cartesiaHigh)}`,
      `${cartesiaInkPerHour(cartesiaCheapest)} to ${cartesiaInkPerHour(cartesiaDearest)} (Ink, not used by Rakazo)`,
      `${count(RATES.cartesiaFreeCredits)} credits a month`,
      "Built in, speaks only",
    ],
  },
  fish: {
    topic: "[Fish Audio](/voice-providers/fish-audio/) S2.1 Pro",
    cells: [
      `${usd(RATES.fish)} per 1M bytes, the same as characters in English`,
      perHourOfSpeech(RATES.fish),
      usd(RATES.fishTranscribeHour),
      `Free app plan, about ${RATES.fishPlans.free.minutes} minutes a month`,
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
      `${usd(RATES.deepinfraKokoro)} or ${usd(RATES.togetherKokoro)}`,
      `${perHourOfSpeech(RATES.deepinfraKokoro)} or ${perHourOfSpeech(RATES.togetherKokoro)}`,
      `Whisper from $${RATES.deepinfraWhisperHour} (DeepInfra)`,
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
      usd(RATES.deepgram),
      perHourOfSpeech(RATES.deepgram),
      `${usd(RATES.deepgramBatchHour)} batch, ${usd(RATES.deepgramStreamHour)} streaming`,
      `${usd(RATES.deepgramCredit)} credit`,
      "Not available",
    ],
  },
  google: {
    topic: "Google Cloud Chirp 3 HD",
    cells: [
      usd(RATES.googleChirp),
      perHourOfSpeech(RATES.googleChirp),
      usd(RATES.googleSttHour),
      `${millions(RATES.googleFreeChars)} characters a month`,
      "Not available",
    ],
  },
  azure: {
    topic: "Azure AI Speech, neural or HD",
    cells: [
      `${usd(RATES.azureNeural)} or ${usd(RATES.azureHd)}`,
      `${perHourOfSpeech(RATES.azureNeural)} or ${perHourOfSpeech(RATES.azureHd)}`,
      `${usd(RATES.azureRealtimeHour)} real time, ${usd(RATES.azureBatchHour)} batch`,
      `${millions(RATES.azureFreeChars)} characters and ${RATES.azureFreeHours} hours a month`,
      "Not available",
    ],
  },
  polly: {
    topic: "Amazon Polly neural or generative",
    cells: [
      `${usd(RATES.pollyNeural)} or ${usd(RATES.pollyGenerative)}`,
      `${perHourOfSpeech(RATES.pollyNeural)} or ${perHourOfSpeech(RATES.pollyGenerative)}`,
      `${usd(RATES.transcribeBatchHour)} batch, ${usd(RATES.transcribeStreamHour)} streaming (Transcribe)`,
      "Neural: 1M characters a month for a year",
      "Not available",
    ],
  },
  inworld: {
    topic: "Inworld TTS-2 or TTS-2 Flash",
    cells: [
      `${usd(RATES.inworld)} or ${usd(RATES.inworldFlash)}`,
      `${perHourOfSpeech(RATES.inworld)} or ${perHourOfSpeech(RATES.inworldFlash)}`,
      usd(RATES.inworldSttHour),
      "Up to 70 minutes of speech",
      "Not available",
    ],
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

const S = PRICING_SOURCES;

/** The pricing pages behind each row of {@link PRICE_ROWS}. */
const PRICE_ROW_SOURCES: Record<VoicePriceRow, readonly SourceLink[]> = {
  elevenlabs: [S.elevenlabsApi],
  elevenlabsV4: [S.elevenlabsApi],
  openai: [S.openai],
  openaiTts1: [S.openai],
  cartesia: [S.cartesia],
  fish: [S.fish, S.fishPlans],
  selfHosted: [],
  hostedKokoro: [S.deepinfra, S.together],
  macos: [],
  deepgram: [S.deepgram],
  google: [S.google, S.googleStt],
  azure: [S.azure],
  polly: [S.polly, S.transcribe],
  inworld: [S.inworld],
};

/** Sources for every price on the voice pages, for the hub. */
export const ALL_PRICING_SOURCES: readonly SourceLink[] = Object.values(PRICING_SOURCES);

/** The worked example: daily minutes of speech and of transcription, over 30 days. */
export const WORKLOAD_DAILY_MINUTES = 30;
export const WORKLOAD_HOURS = (WORKLOAD_DAILY_MINUTES * 30) / 60;
export const WORKLOAD_CHARS = WORKLOAD_HOURS * CHARS_PER_HOUR;

export const WORKLOAD = `The worked example is one bot that reads about ${WORKLOAD_DAILY_MINUTES} minutes of replies aloud each day and transcribes about ${WORKLOAD_DAILY_MINUTES} minutes of what you say, every day for a month: ${WORKLOAD_HOURS} hours of speech (about ${count(WORKLOAD_CHARS)} characters) and ${WORKLOAD_HOURS} hours of transcription.`;

/** Speech cost of {@link WORKLOAD_CHARS} at a price per 1M characters, after free characters. */
function workloadSpeech(pricePerMillion: number, freeChars = 0): number {
  return (Math.max(0, WORKLOAD_CHARS - freeChars) * pricePerMillion) / 1_000_000;
}

function workloadTranscription(pricePerHour: number, freeHours = 0): number {
  return Math.max(0, WORKLOAD_HOURS - freeHours) * pricePerHour;
}

/** The smallest Cartesia plan whose credits cover the worked example. */
const CARTESIA_WORKLOAD_PLAN = (["pro", "startup", "scale"] as const).find(
  (plan) => RATES.cartesiaPlans[plan].credits >= WORKLOAD_CHARS,
) as keyof typeof RATES.cartesiaPlans;

/** Monthly cost of the {@link WORKLOAD} per option, as numbers, for tables and text alike. */
export const WORKLOAD_COST = {
  elevenlabs: {
    speech: workloadSpeech(RATES.elevenlabsFlash),
    transcription: workloadTranscription(RATES.elevenlabsScribeHour),
  },
  openai: {
    speech: WORKLOAD_HOURS * OPENAI_MINI_TTS_HOUR,
    transcription: workloadTranscription(RATES.openaiMiniTranscribeHour),
  },
  cartesia: {
    speech: RATES.cartesiaPlans[CARTESIA_WORKLOAD_PLAN].price,
    transcription: 0,
  },
  fish: {
    speech: workloadSpeech(RATES.fish),
    transcription: workloadTranscription(RATES.fishTranscribeHour),
  },
  deepgram: {
    speech: workloadSpeech(RATES.deepgram),
    transcription: workloadTranscription(RATES.deepgramBatchHour),
  },
  google: {
    speech: workloadSpeech(RATES.googleChirp, RATES.googleFreeChars),
    transcription: workloadTranscription(RATES.googleSttHour),
  },
  azure: {
    speech: workloadSpeech(RATES.azureNeural, RATES.azureFreeChars),
    transcription: workloadTranscription(RATES.azureRealtimeHour, RATES.azureFreeHours),
  },
} satisfies Record<string, { speech: number; transcription: number }>;

export type WorkloadOption = keyof typeof WORKLOAD_COST;

export const WORKLOAD_NAMES: Record<WorkloadOption, string> = {
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  cartesia: "Cartesia",
  fish: "Fish Audio",
  deepgram: "Deepgram",
  google: "Google",
  azure: "Azure",
};

/** The worked example's monthly total on an option. */
export function workloadTotal(option: WorkloadOption): number {
  const { speech, transcription } = WORKLOAD_COST[option];
  return speech + transcription;
}

/** "About $36": a monthly total rounded to whole dollars. */
export function aboutTotal(option: WorkloadOption): string {
  return `About $${Math.round(workloadTotal(option))}`;
}

/** The cheapest and dearest of these options for the worked example. */
export function workloadExtremes(
  options: readonly WorkloadOption[] = Object.keys(WORKLOAD_COST) as WorkloadOption[],
): { cheapest: WorkloadOption; dearest: WorkloadOption } {
  const sorted = [...options].sort((a, b) => workloadTotal(a) - workloadTotal(b));
  return { cheapest: sorted[0] ?? options[0]!, dearest: sorted.at(-1) ?? options[0]! };
}

/** Hourly transcription prices per provider, every model and mode the voice pages quote. */
export const TRANSCRIPTION_HOURLY: Record<string, readonly number[]> = {
  OpenAI: Object.values(RATES.openaiTranscribeMinute).map((minute) => minute * 60),
  ElevenLabs: [RATES.elevenlabsScribeHour, RATES.elevenlabsScribeRealtimeHour],
  "Fish Audio": [RATES.fishTranscribeHour],
  Deepgram: [RATES.deepgramBatchHour, RATES.deepgramStreamHour],
  AssemblyAI: [RATES.assemblyaiHour.low, RATES.assemblyaiHour.high],
  Groq: [RATES.groqWhisperHour],
  Google: [RATES.googleSttHour],
  Azure: [RATES.azureBatchHour, RATES.azureRealtimeHour],
  Amazon: [RATES.transcribeBatchHour, RATES.transcribeStreamHour],
};

/** The lowest and highest hourly transcription price across {@link TRANSCRIPTION_HOURLY}, with who charges it. */
export function transcriptionRange(): {
  low: { name: string; price: number };
  high: { name: string; price: number };
} {
  const all = Object.entries(TRANSCRIPTION_HOURLY).flatMap(([name, prices]) =>
    prices.map((price) => ({ name, price })),
  );
  const sorted = all.sort((a, b) => a.price - b.price);
  return { low: sorted[0]!, high: sorted.at(-1)! };
}

const cost = WORKLOAD_COST;

const WORKLOAD_ROWS = {
  elevenlabs: {
    topic: "[ElevenLabs](/voice-providers/elevenlabs/)",
    cells: [usd(cost.elevenlabs.speech), usd(cost.elevenlabs.transcription), aboutTotal("elevenlabs")],
  },
  openai: {
    topic: "[OpenAI](/voice-providers/openai/)",
    cells: [
      `About ${usd(cost.openai.speech)}`,
      usd(cost.openai.transcription),
      `${aboutTotal("openai")}, until the 2027 shutdown`,
    ],
  },
  cartesia: {
    topic: "[Cartesia](/voice-providers/cartesia/)",
    cells: [
      `${usd(cost.cartesia.speech)} (${CARTESIA_WORKLOAD_PLAN.charAt(0).toUpperCase()}${CARTESIA_WORKLOAD_PLAN.slice(1)} plan fee)`,
      "$0, your device listens",
      usd(cost.cartesia.speech),
    ],
  },
  fish: {
    topic: "[Fish Audio](/voice-providers/fish-audio/)",
    cells: [usd(cost.fish.speech), usd(cost.fish.transcription), aboutTotal("fish")],
  },
  selfHosted: {
    topic: "[Self-hosted](/voice-providers/self-hosted/) on a computer you own",
    cells: ["Electricity", "Electricity", "About $0"],
  },
  selfHostedCloud: {
    topic: "Self-hosted on a small rented CPU server",
    cells: ["Included", "Included", `About ${usd(RATES.cpuServerMonth)}, slower`],
  },
  macos: {
    topic: "[Server (Mac)](/voice-providers/macos/)",
    cells: ["$0", "$0, your device listens", "$0"],
  },
  deepgram: {
    topic: "Deepgram (not in Rakazo)",
    cells: [usd(cost.deepgram.speech), usd(cost.deepgram.transcription), aboutTotal("deepgram")],
  },
  google: {
    topic: "Google Cloud (not in Rakazo)",
    cells: [
      cost.google.speech === 0
        ? `$0, inside the free ${millions(RATES.googleFreeChars)}`
        : usd(cost.google.speech),
      usd(cost.google.transcription),
      aboutTotal("google"),
    ],
  },
  azure: {
    topic: "Azure AI Speech (not in Rakazo)",
    cells: [
      `${usd(cost.azure.speech)} after the free ${millions(RATES.azureFreeChars)}`,
      `${usd(cost.azure.transcription)} after ${RATES.azureFreeHours} free hours`,
      aboutTotal("azure"),
    ],
  },
} satisfies Record<string, { topic: string; cells: readonly string[] }>;

export type VoiceWorkloadRow = keyof typeof WORKLOAD_ROWS;

/** The pricing pages behind each row of {@link WORKLOAD_ROWS}. */
const WORKLOAD_ROW_SOURCES: Record<VoiceWorkloadRow, readonly SourceLink[]> = {
  elevenlabs: [S.elevenlabsApi],
  openai: [S.openai],
  cartesia: [S.cartesia],
  fish: [S.fish],
  selfHosted: [],
  selfHostedCloud: [S.hetzner],
  macos: [],
  deepgram: [S.deepgram],
  google: [S.google, S.googleStt],
  azure: [S.azure],
};

/**
 * A page's own sources followed by the pricing pages behind the shared tables it shows,
 * without repeats, so a page can't show a price without linking where it came from.
 */
export function withPricingSources(
  own: readonly SourceLink[],
  tables: { prices?: readonly VoicePriceRow[]; workload?: readonly VoiceWorkloadRow[] },
): SourceLink[] {
  const all = [
    ...own,
    ...(tables.prices ?? []).flatMap((row) => PRICE_ROW_SOURCES[row]),
    ...(tables.workload ?? []).flatMap((row) => WORKLOAD_ROW_SOURCES[row]),
  ];
  return all.filter((source, index) => all.findIndex((other) => other.href === source.href) === index);
}

/** "cheaper than", "more expensive than" or, within 10%, "about the same as". */
export function priceVersus(price: number, other: number): string {
  if (Math.abs(price - other) <= other * 0.1) return "about the same as";
  return price < other ? "cheaper than" : "more expensive than";
}

/** One price as a share of another, such as "about 38% of". */
export function shareOf(price: number, other: number): string {
  return `about ${Math.round((price / other) * 100)}% of`;
}

/** What the {@link WORKLOAD} costs a month on the chosen options. */
export function voiceWorkloadTable(
  caption: string,
  rows: readonly VoiceWorkloadRow[],
): ArticleTable {
  return {
    caption,
    columns: ["Option", "Speech", "Transcription", "A month"],
    rows: rows.map((row) => WORKLOAD_ROWS[row]),
    note: "Usage prices from each provider's pricing page, checked November 2026. Where speech is bought as a monthly plan, as with Cartesia, the cost shown is the fee for the smallest plan that covers it. Rakazo doesn't charge for voice: you connect your own key and the provider bills you.",
  };
}
