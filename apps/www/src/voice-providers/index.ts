import { absolute, articleMarkdown, cell, sectionMarkdown } from "../provider-article/markdown";
import type { ArticleHub, ArticleLink, ArticleSection } from "../provider-article/types";
import { SITE_URL } from "../site";
import { cartesia } from "./cartesia";
import { elevenlabs } from "./elevenlabs";
import { fishAudio } from "./fish-audio";
import { macos } from "./macos";
import { openai } from "./openai";
import { selfHosted } from "./self-hosted";
import {
  ALL_PRICING_SOURCES,
  CARTESIA_RANGE,
  TRANSCRIPTION_HOURLY,
  WORKLOAD_NAMES,
  transcriptionRange,
  RATES,
  VOICE_DOC,
  VOICE_DOCS_PATH,
  VOICE_PROVIDERS_PATH,
  VOICE_PROVIDERS_UPDATED,
  WORKLOAD,
  WORKLOAD_COST,
  count,
  millions,
  perHourOfSpeech,
  speechHourCost,
  usd,
  voicePriceTable,
  voiceProviderPath,
  voiceWorkloadTable,
} from "./shared";
import type { VoiceProvider } from "./types";

export * from "./shared";
export type { VoiceProvider } from "./types";

/** Display order everywhere voice providers are listed. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
  elevenlabs,
  openai,
  cartesia,
  fishAudio,
  selfHosted,
  macos,
];

/** Options in the worked example where transcription costs more than speech, such as after a free speech allowance. */
const TRANSCRIPTION_HEAVY = (Object.keys(WORKLOAD_COST) as (keyof typeof WORKLOAD_COST)[])
  .filter((key) => WORKLOAD_COST[key].transcription > WORKLOAD_COST[key].speech)
  .map((key) => WORKLOAD_NAMES[key]);

const TRANSCRIPTION_RANGE = transcriptionRange();

function listed(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

const BILL_ADVICE = `Speech is usually the larger charge, so how much your bots say matters more than how much you say${TRANSCRIPTION_HEAVY.length ? `. The exception is where a free speech allowance covers most of the month, as with ${listed(TRANSCRIPTION_HEAVY)} here, which leaves transcription as the main cost` : ""}. In Chrome on a desktop or in the mobile app, your device often does the transcription for free. A self-hosted Rakazo can also set \`VOICE_SUMMARY_MIN_CHARS\` so long replies are read as a short summary instead of in full.`;

/** Hosted options in Rakazo whose speech costs under a dollar an hour. */
const UNDER_A_DOLLAR = [
  { name: "[Fish Audio](/voice-providers/fish-audio/)", hour: speechHourCost(RATES.fish) },
  { name: "xAI", hour: speechHourCost(RATES.xai) },
  { name: "[OpenAI](/voice-providers/openai/)", hour: RATES.openaiMiniTtsMinute * 60 },
  { name: "[ElevenLabs](/voice-providers/elevenlabs/)", hour: speechHourCost(RATES.elevenlabsFlash) },
  {
    name: "[Cartesia](/voice-providers/cartesia/)",
    hour: speechHourCost(CARTESIA_RANGE.low),
  },
]
  .filter((option) => option.hour < 1)
  .map((option) => option.name);

const HUB_SECTIONS: readonly ArticleSection[] = [
  {
    heading: "Text to speech API pricing compared",
    paragraphs: [
      "Voice APIs price speech per character or per token and transcription per minute, and their plans bundle credits differently, so the table converts everything to the same units: dollars per million characters, per hour of generated speech, and per hour of transcribed audio. Rakazo doesn't charge for voice; you connect your own key and the provider bills you.",
    ],
    table: voicePriceTable("Voice APIs for AI agents, as of November 2026", [
      "elevenlabs",
      "elevenlabsV4",
      "openai",
      "openaiTts1",
      "cartesia",
      "fish",
      "xai",
      "selfHosted",
      "hostedKokoro",
      "macos",
      "deepgram",
      "google",
      "azure",
      "polly",
      "inworld",
    ]),
  },
  {
    heading: "What a talking AI agent costs a month",
    paragraphs: [
      WORKLOAD,
      BILL_ADVICE,
    ],
    table: voiceWorkloadTable("One bot, 30 minutes of speech and 30 of transcription a day", [
      "macos",
      "selfHosted",
      "selfHostedCloud",
      "xai",
      "openai",
      "fish",
      "elevenlabs",
      "cartesia",
      "deepgram",
      "google",
      "azure",
    ]),
  },
  {
    heading: "What each option does in Rakazo",
    table: {
      caption: "Voice options in Rakazo",
      columns: ["Option", "Speaks with", "Transcribes with", "Your cloned voices", "Audio goes to"],
      rows: [
        {
          topic: "[ElevenLabs](/voice-providers/elevenlabs/)",
          cells: ["Flash v2.5", "Scribe v2", "Yes", "ElevenLabs"],
        },
        {
          topic: "[OpenAI](/voice-providers/openai/)",
          cells: [
            "`gpt-4o-mini-tts`, until January 6, 2027",
            "`gpt-4o-mini-transcribe`, until February 26, 2027",
            "No",
            "OpenAI",
          ],
        },
        {
          topic: "[Cartesia](/voice-providers/cartesia/)",
          cells: ["Sonic 3", "Your device", "Yes", "Cartesia"],
        },
        {
          topic: "[Fish Audio](/voice-providers/fish-audio/)",
          cells: ["S2.1 Pro, or a model you choose", "`transcribe-1-pro`", "Yes", "Fish Audio"],
        },
        {
          topic: "xAI",
          cells: ["Grok voices", "Grok speech to text", "No", "xAI"],
        },
        {
          topic: "[Self-hosted](/voice-providers/self-hosted/)",
          cells: [
            "Your model, such as Kokoro",
            "Your model, such as Whisper",
            "If your model clones",
            "Your server",
          ],
        },
        {
          topic: "[Server (Mac)](/voice-providers/macos/)",
          cells: ["macOS voices", "Your device", "No", "The Mac running Rakazo"],
        },
      ],
    },
  },
  {
    heading: "Voice APIs Rakazo doesn't connect to",
    paragraphs: [
      "Plenty of good voice APIs have no built-in connection in Rakazo. Here is how they compare, so you can judge what you'd be missing.",
    ],
    bullets: [
      `Deepgram is best known for transcription: Nova-3 costs ${usd(RATES.deepgramBatchHour)} an hour in batch and ${usd(RATES.deepgramStreamHour)} streaming, with a ${usd(RATES.deepgramCredit)} starting credit, and many voice agents use it to listen. Its Aura-2 voices cost ${usd(RATES.deepgram)} per million characters and sound plainer than ElevenLabs. It uses its own API, not OpenAI's.`,
      `Google Cloud's Chirp 3 HD voices cost ${usd(RATES.googleChirp)} per million characters with the first ${millions(RATES.googleFreeChars)} free each month, and its Speech-to-Text costs about ${usd(RATES.googleSttHour)} an hour. Gemini's speech models are billed per token.`,
      `Azure AI Speech has neural voices at ${usd(RATES.azureNeural)} per million characters, HD voices at ${usd(RATES.azureHd)}, and transcription from ${usd(RATES.azureBatchHour)} an hour in batch, with a monthly free tier of ${millions(RATES.azureFreeChars)} characters and ${RATES.azureFreeHours} hours.`,
      `Amazon Polly's neural voices cost ${usd(RATES.pollyNeural)} and generative voices ${usd(RATES.pollyGenerative)} per million characters. Amazon Transcribe costs about ${usd(RATES.transcribeBatchHour)} an hour in batch.`,
      `Inworld sells low-cost voices for agents, ${usd(RATES.inworldFlash)} to ${usd(RATES.inworld)} per million characters. Hume's Octave focuses on emotional delivery; its rates were no longer on its pricing page in November 2026.`,
      `AssemblyAI (${usd(RATES.assemblyaiHour.low)} to ${usd(RATES.assemblyaiHour.high)} an hour) and Groq's hosted Whisper (${usd(RATES.groqWhisperHour)} an hour) are strong for transcription. Groq serves OpenAI's audio API shape, so it may be reachable through **Self-hosted**, but Rakazo would send speech there too.`,
      "PlayHT, once a common ElevenLabs alternative, shut down its platform and API at the end of 2025.",
    ],
  },
];

export const VOICE_PROVIDERS_HUB = {
  title: "Best text to speech and speech to text APIs for AI agents in 2026: pricing compared",
  description:
    "ElevenLabs, OpenAI, Cartesia, Fish Audio, xAI, Deepgram, Google, Azure, Kokoro and macOS voices compared on price per hour, transcription, cloning and privacy, with what a talking AI agent costs a month. From the team behind Rakazo.",
  h1: "Best voice APIs for AI agents in 2026: text to speech and transcription compared",
  intro: [
    "Typing isn't always the fastest way to work with an AI agent. Sometimes you want to say what you need on the way out the door, hear the answer while you cook, or have the agent call you when something can't wait. That takes two things: a voice that sounds right, and transcription that hears you correctly.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also hold the mic to speak, have replies read aloud, or call a bot. A bot can call you too. The voice provider you connect does the speaking and, for most providers, the listening. This page compares every option Rakazo supports, from hosted voices to a server you run yourself, against the other voice APIs people consider, with prices as of November 2026.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "On a call",
    ask: "call me at 5 to go over the day",
    reply: "calling now. two things need you, the rest is handled.",
    results: [
      { k: "Call", v: "6 min, transcript saved in the chat" },
      { k: "Decided", v: "harbor house booked, contract out" },
      { k: "Waiting", v: "your ok on the travel budget" },
    ],
  },
  sections: HUB_SECTIONS,
  sources: [...ALL_PRICING_SOURCES, VOICE_DOC],
  choose: [
    {
      heading: "You want the most natural voices",
      text: `[ElevenLabs](/voice-providers/elevenlabs/) speaks and transcribes with one key, and any voice you clone in ElevenLabs shows up in Rakazo's voice picker. It costs about ${perHourOfSpeech(RATES.elevenlabsFlash)} per hour of speech. [Fish Audio](/voice-providers/fish-audio/) is the other pick when the voice itself matters, with expressive speech, your own cloned voice and a large public library, at ${perHourOfSpeech(RATES.fish)} an hour.`,
    },
    {
      heading: "You want the lowest bill",
      text: `Free options first: [Server (Mac)](/voice-providers/macos/) if Rakazo runs on a Mac, or a [self-hosted](/voice-providers/self-hosted/) Kokoro and Whisper server on hardware you already own. Among hosted APIs, ${listed(UNDER_A_DOLLAR)} ${UNDER_A_DOLLAR.length > 1 ? "each cost" : "costs"} under a dollar per hour of speech.`,
    },
    {
      heading: "You already have an OpenAI key",
      text: "[OpenAI](/voice-providers/openai/) is quick to set up, with built-in voices and solid transcription. OpenAI is shutting down the speech model Rakazo uses on January 6, 2027, and the transcription model on February 26, 2027, so treat it as a convenient start.",
    },
    {
      heading: "You mostly call your bots",
      text: "[Cartesia](/voice-providers/cartesia/) voices start fast and sound natural on calls. It only speaks, so your browser, the desktop app or your phone does the listening, which also means no transcription bill.",
    },
    {
      heading: "You want audio to stay on your own hardware",
      text: "[Self-hosted voice](/voice-providers/self-hosted/) works with any OpenAI-compatible speech server, such as Kokoro for speech and a Whisper server for transcription. If you run Rakazo directly on a Mac, [Server (Mac)](/voice-providers/macos/) speaks with the built-in voices and no key at all.",
    },
    {
      heading: "You need compliance paperwork",
      text: "Zero data retention, data residency and HIPAA agreements are Enterprise features at ElevenLabs, Cartesia and Fish Audio; OpenAI offers zero retention with its approval. If audio can't leave your network at all, [self-host](/voice-providers/self-hosted/) it.",
    },
  ],
  faq: [
    {
      question: "What is the best text to speech API for AI agents?",
      answer:
        "For the most natural voices, [ElevenLabs](/voice-providers/elevenlabs/). For the lowest latency on calls, [Cartesia](/voice-providers/cartesia/). For price, [Fish Audio](/voice-providers/fish-audio/) or a [self-hosted](/voice-providers/self-hosted/) Kokoro server. All four work in Rakazo.",
    },
    {
      question: "Which text to speech API is free?",
      answer:
        `macOS voices and open models such as Kokoro are free to run yourself. Among hosted APIs, Google gives ${millions(RATES.googleFreeChars)} Chirp 3 HD characters a month, Azure ${millions(RATES.azureFreeChars)}, ElevenLabs ${count(RATES.elevenlabsPlans.free.credits)} credits for non-commercial use, and Cartesia ${count(RATES.cartesiaFreeCredits)} credits. Fish Audio's free plan covers its app only; its API is pay as you go.`,
    },
    {
      question: "What is the most accurate speech to text API?",
      answer:
        "It depends on your audio and language, and independent tests disagree. Deepgram Nova-3, AssemblyAI, ElevenLabs Scribe v2 and OpenAI's transcription models are all near the top for English. Open models such as Whisper large-v3-turbo and NVIDIA Parakeet are close behind and free to run.",
    },
    {
      question: "Is there an API that can convert audio to text?",
      answer:
        `Yes, many: ${listed(Object.keys(TRANSCRIPTION_HOURLY))} all do. Across the models and modes on this page, prices run from about ${usd(TRANSCRIPTION_RANGE.low.price)} an hour (${TRANSCRIPTION_RANGE.low.name}) to ${usd(TRANSCRIPTION_RANGE.high.price)} (${TRANSCRIPTION_RANGE.high.name}). In Rakazo, ElevenLabs, OpenAI, Fish Audio, xAI and self-hosted servers transcribe what you say.`,
    },
    {
      question: "Is the Whisper API free?",
      answer:
        `No. OpenAI charges ${usd(RATES.openaiWhisperHour)} an hour for Whisper, and it shuts down on February 26, 2027. The Whisper model itself is open source, so you can run it free on your own hardware and connect it to Rakazo as a [self-hosted](/voice-providers/self-hosted/) server.`,
    },
    {
      question: "Is Deepgram text to speech?",
      answer:
        "Both. Deepgram is known for speech to text (Nova-3) and also sells Aura-2 voices. Rakazo doesn't connect to Deepgram.",
    },
    {
      question: "Can I talk to my AI agent by voice?",
      answer:
        "Yes. Connect a provider in **Settings → Voice**, then hold the mic to speak, have replies read aloud, or call a bot. On a [self-hosted Rakazo](/self-hosted-ai-agent/), the admin turns on calls and hold-to-talk with `PHONE_CALLS_ENABLED=true`.",
    },
    {
      question: "Which voice providers can transcribe?",
      answer:
        "ElevenLabs, OpenAI, Fish Audio, xAI, and self-hosted servers that support transcription. Cartesia and **Server (Mac)** only speak, so your browser, the desktop app or your phone listens instead.",
    },
    {
      question: "Can AI agents use voice without a hosted vendor?",
      answer:
        "Yes. Point Rakazo at a [self-hosted speech server](/voice-providers/self-hosted/), or use [Server (Mac)](/voice-providers/macos/) when the server runs on a Mac.",
    },
    {
      question: "Is using an AI voice legal?",
      answer:
        "Generally yes, for voices you have the right to use. Cloning someone's voice without consent can break laws on likeness and fraud, and OpenAI's policies ask you to tell listeners the voice is AI-generated. Only clone voices you have permission for.",
    },
    {
      question: "Can each bot have its own voice?",
      answer:
        "Yes. In a bot's settings, turn on **Read replies aloud** and pick a **Voice** next to it to override your default for that bot.",
    },
    {
      question: "Can my bot call me?",
      answer:
        "Yes, in a one-to-one chat once you've connected a voice provider and calls are on. Ask \"call me at 5 to go over the day\", or a bot may call when you've missed the same reminder several times.",
    },
  ],
};

export const VOICE_PROVIDERS_ARTICLE_HUB: ArticleHub = {
  label: "Voice providers for AI agents",
  compareLabel: "Compare all voice providers",
  href: VOICE_PROVIDERS_PATH,
  moreHeading: "More voice providers for AI agents",
  guide: { label: "Voice and calls guide", href: VOICE_DOCS_PATH },
};

export function voiceProviderLink(provider: VoiceProvider): ArticleLink {
  return {
    name: provider.name,
    href: voiceProviderPath(provider.slug),
    meta: provider.bestFor,
    image: provider.image,
  };
}

export function otherVoiceProviders(provider: VoiceProvider): ArticleLink[] {
  return VOICE_PROVIDERS.filter((other) => other.slug !== provider.slug).map(
    voiceProviderLink,
  );
}

/** Markdown twin of a voice provider page, for agents and `.md` requests. */
export function voiceProviderMarkdown(provider: VoiceProvider): string {
  return articleMarkdown(provider, {
    hub: VOICE_PROVIDERS_ARTICLE_HUB,
    others: otherVoiceProviders(provider),
    updated: VOICE_PROVIDERS_UPDATED,
  });
}

/** Markdown twin of the voice providers hub. */
export function voiceProvidersHubMarkdown(): string {
  const hub = VOICE_PROVIDERS_HUB;
  return [
    `# ${hub.h1}`,
    "",
    ...hub.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${VOICE_PROVIDERS_UPDATED}.`,
    "",
    "## Compared",
    "",
    "| Provider | Does | Runs | Best for |",
    "| --- | --- | --- | --- |",
    ...VOICE_PROVIDERS.map(
      (provider) =>
        `| [${cell(provider.name)}](${SITE_URL}${voiceProviderPath(provider.slug)}) | ${cell(provider.does)} | ${cell(provider.runs)} | ${cell(provider.bestFor)} |`,
    ),
    "",
    ...hub.sections.flatMap(sectionMarkdown),
    "## How to choose",
    "",
    ...hub.choose.flatMap((item) => [`### ${item.heading}`, "", absolute(item.text), ""]),
    `[Voice and calls guide](${SITE_URL}${VOICE_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...hub.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
    "## Sources",
    "",
    ...hub.sources.map((source) => `- [${source.label}](${source.href})`),
    "",
  ].join("\n");
}
